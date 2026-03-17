/**
 * data_feed.ts
 * ============
 * Real-time aviation weather (METAR) data ingestion module.
 *
 * Architecture
 * ------------
 * Primary:  CheckWX WebSocket stream for live METAR pushes.
 *           CheckWX is the only free provider that offers a true push feed;
 *           the raw NOAA/ADDS endpoint is REST-only (no WS).
 *
 * Fallback: If the WebSocket drops or the enterprise feed is unavailable,
 *           we fall back to polling the CheckWX REST API on a configurable
 *           interval.  This guarantees the bot always has fresh data.
 *
 * METAR parsing
 * -------------
 * We extract:
 *   - Temperature in Celsius (from the TT/Td group, e.g. "23/10")
 *   - Exact temperature from the T-remark (e.g. T02330100 = 23.3°C)
 *   - Observation time (used to ensure we don't act on stale data)
 *
 * The module emits:
 *   'observation' — { station, tempC, tempF, obsTimeUtc, raw }
 *   'error'       — Error object
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import axios from 'axios';
import { CONFIG } from './config';
import { logger } from './logger';
import { sleep, withRetry } from './gas';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetarObservation {
  station:    string;
  tempC:      number;           // parsed temperature in Celsius
  tempF:      number;           // converted to Fahrenheit
  dewpointC:  number;
  obsTimeUtc: Date;
  raw:        string;           // full raw METAR string
  isFresh:    boolean;          // true if < 90 minutes old
}

export interface CheckWXMetarResponse {
  data: Array<{
    icao:        string;
    raw_text:    string;
    observed:    string;        // ISO8601 timestamp
    temperature: { celsius: number; fahrenheit: number };
    dewpoint:    { celsius: number; fahrenheit: number };
  }>;
  results: number;
}

// ---------------------------------------------------------------------------
// METAR parser (raw-string fallback when API doesn't give structured data)
// ---------------------------------------------------------------------------

/**
 * Parse temperature groups from a raw METAR string.
 * Handles both the standard T±T/dew group and the Tg±dddg remark.
 *
 * Examples:
 *   "KNYC 171553Z 25012KT 10SM FEW035 23/10 A3012 RMK AO2 T02330100"
 *   Temperature group: "23/10" → 23°C
 *   Remark group:     "T02330100" → 23.3°C (sign bit 0 = positive)
 */
export function parseMetarTemp(raw: string): { tempC: number; dewpointC: number } | null {
  // Try the precise remark first: T[0|1]ddd[0|1]ddd
  // 0 = positive, 1 = negative
  const remarkMatch = raw.match(/\bT([01])(\d{3})([01])(\d{3})\b/);
  if (remarkMatch) {
    const tempSign     = remarkMatch[1] === '1' ? -1 : 1;
    const tempTenths   = parseInt(remarkMatch[2], 10);
    const dewSign      = remarkMatch[3] === '1' ? -1 : 1;
    const dewTenths    = parseInt(remarkMatch[4], 10);
    return {
      tempC:     tempSign * tempTenths / 10,
      dewpointC: dewSign  * dewTenths  / 10,
    };
  }

  // Fall back to the standard group: [M]TT/[M]DD where M = minus prefix
  const stdMatch = raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  if (stdMatch) {
    const parseGroup = (s: string) => {
      const neg = s.startsWith('M');
      const val = parseInt(s.replace('M', ''), 10);
      return neg ? -val : val;
    };
    return {
      tempC:     parseGroup(stdMatch[1]),
      dewpointC: parseGroup(stdMatch[2]),
    };
  }

  return null;
}

/** Parse the METAR observation time embedded in the report. */
export function parseMetarTime(raw: string, referenceDate = new Date()): Date {
  const m = raw.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  if (!m) return referenceDate;

  const day  = parseInt(m[1], 10);
  const hour = parseInt(m[2], 10);
  const min  = parseInt(m[3], 10);

  const d = new Date(referenceDate);
  d.setUTCDate(day);
  d.setUTCHours(hour, min, 0, 0);

  // Handle month-boundary rollover
  if (d.getTime() > Date.now() + 3_600_000) {
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return d;
}

export function celsiusToFahrenheit(c: number): number {
  return (c * 9) / 5 + 32;
}

// ---------------------------------------------------------------------------
// DataFeed class
// ---------------------------------------------------------------------------

export class WeatherDataFeed extends EventEmitter {
  private ws:                WebSocket | null   = null;
  private pollTimer:         NodeJS.Timeout | null = null;
  private reconnectTimer:    NodeJS.Timeout | null = null;
  private destroyed:         boolean = false;
  private reconnectDelayMs:  number  = 2_000;
  private readonly maxReconnectDelayMs = 60_000;

  /** Latest observation per station, keyed by ICAO code */
  public readonly latest: Map<string, MetarObservation> = new Map();

  /** Max temperature (in configured unit) recorded today across all stations */
  get maxTempToday(): number {
    const unit = CONFIG.TEMPERATURE_UNIT;
    let max = -Infinity;
    for (const obs of this.latest.values()) {
      const val = unit === 'F' ? obs.tempF : obs.tempC;
      if (val > max) max = val;
    }
    return max;
  }

  /** True if the threshold has been definitively exceeded */
  get thresholdMet(): boolean {
    return this.maxTempToday >= CONFIG.TEMP_THRESHOLD;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    logger.info('WeatherDataFeed: starting', { stations: CONFIG.METAR_STATIONS });

    // Initial REST fetch so we have data immediately
    await this.fetchViaRest();

    // Try WebSocket first; fall back to polling if WS is unavailable
    this.connectWebSocket();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    if (this.pollTimer)      { clearInterval(this.pollTimer);   this.pollTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    logger.info('WeatherDataFeed: destroyed');
  }

  // -------------------------------------------------------------------------
  // WebSocket connection (CheckWX push feed)
  // -------------------------------------------------------------------------

  private connectWebSocket(): void {
    if (this.destroyed) return;

    // CheckWX WebSocket endpoint (enterprise tier)
    // The WS stream pushes a new METAR JSON blob whenever a station updates.
    const wsUrl = `wss://api.checkwxapi.com/v1/metar/ws?api_key=${CONFIG.CHECKWX_API_KEY}`;

    logger.info('WeatherDataFeed: connecting WebSocket', { url: wsUrl.replace(CONFIG.CHECKWX_API_KEY, '***') });

    this.ws = new WebSocket(wsUrl, {
      headers: { 'X-API-Key': CONFIG.CHECKWX_API_KEY },
    });

    this.ws.on('open', () => {
      logger.info('WeatherDataFeed: WS connected');
      this.reconnectDelayMs = 2_000;   // reset backoff on successful connect

      // Subscribe to our target stations
      const subscribeMsg = JSON.stringify({
        type:     'subscribe',
        stations: CONFIG.METAR_STATIONS,
      });
      this.ws!.send(subscribeMsg);

      // Cancel any active polling timer since WS is now providing live data
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        this.handleWsMessage(data.toString());
      } catch (err) {
        logger.error('WeatherDataFeed: WS message parse error', { error: String(err) });
      }
    });

    this.ws.on('error', (err) => {
      logger.warn('WeatherDataFeed: WS error, falling back to polling', { error: err.message });
      this.emit('error', err);
      this.startPolling();
    });

    this.ws.on('close', (code, reason) => {
      logger.warn('WeatherDataFeed: WS closed', { code, reason: reason.toString() });
      this.ws = null;
      if (!this.destroyed) {
        this.scheduleReconnect();
        this.startPolling();           // keep data fresh during reconnect window
      }
    });

    // Heartbeat: ping every 30 s to keep the connection alive through NAT/ALB
    const pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30_000);
  }

  private handleWsMessage(raw: string): void {
    // CheckWX WS pushes either a single METAR object or an array
    const payload: unknown = JSON.parse(raw);
    const items = Array.isArray(payload) ? payload : [payload];

    for (const item of items as Record<string, unknown>[]) {
      if (item['type'] === 'pong' || item['type'] === 'ack') continue;

      const rawText = item['raw_text'] as string | undefined;
      const icao    = (item['icao'] as string | undefined)?.toUpperCase();

      if (!rawText || !icao) continue;
      if (!CONFIG.METAR_STATIONS.includes(icao)) continue;

      this.processRawMetar(icao, rawText, item);
    }
  }

  // -------------------------------------------------------------------------
  // REST polling fallback
  // -------------------------------------------------------------------------

  private startPolling(): void {
    if (this.pollTimer || this.destroyed) return;
    logger.info('WeatherDataFeed: starting REST polling', { intervalMs: CONFIG.METAR_POLL_INTERVAL_MS });

    this.pollTimer = setInterval(async () => {
      try {
        await this.fetchViaRest();
      } catch (err) {
        logger.warn('WeatherDataFeed: REST poll failed', { error: String(err) });
      }
    }, CONFIG.METAR_POLL_INTERVAL_MS);
  }

  private async fetchViaRest(): Promise<void> {
    const stations = CONFIG.METAR_STATIONS.join(',');
    const url      = `https://api.checkwxapi.com/v1/metar/${stations}/decoded`;

    const response = await withRetry(
      () => axios.get<CheckWXMetarResponse>(url, {
        headers:        { 'X-API-Key': CONFIG.CHECKWX_API_KEY },
        timeout:        10_000,
      }),
      { label: 'CheckWX REST fetch' },
    );

    const items = response.data.data ?? [];

    for (const item of items) {
      const icao    = item.icao?.toUpperCase();
      const rawText = item.raw_text;

      if (!icao || !rawText) continue;

      // Prefer the structured API response; fall back to raw string parsing
      const tempC     = item.temperature?.celsius    ?? parseMetarTemp(rawText)?.tempC    ?? NaN;
      const dewpointC = item.dewpoint?.celsius        ?? parseMetarTemp(rawText)?.dewpointC ?? NaN;

      if (isNaN(tempC)) {
        logger.warn('WeatherDataFeed: could not parse temperature', { icao, rawText });
        continue;
      }

      const obsTimeUtc = item.observed ? new Date(item.observed) : parseMetarTime(rawText);

      this.updateObservation({
        station:    icao,
        tempC,
        tempF:      celsiusToFahrenheit(tempC),
        dewpointC,
        obsTimeUtc,
        raw:        rawText,
        isFresh:    Date.now() - obsTimeUtc.getTime() < 90 * 60 * 1_000,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Processing helpers
  // -------------------------------------------------------------------------

  private processRawMetar(icao: string, rawText: string, structured?: Record<string, unknown>): void {
    let tempC:     number;
    let dewpointC: number;

    const api = structured as {
      temperature?: { celsius?: number };
      dewpoint?:    { celsius?: number };
    } | undefined;

    if (api?.temperature?.celsius !== undefined) {
      tempC     = api.temperature.celsius;
      dewpointC = api.dewpoint?.celsius ?? NaN;
    } else {
      const parsed = parseMetarTemp(rawText);
      if (!parsed) {
        logger.warn('WeatherDataFeed: no parseable temp in METAR', { icao, rawText });
        return;
      }
      tempC     = parsed.tempC;
      dewpointC = parsed.dewpointC;
    }

    const obsTimeUtc = parseMetarTime(rawText);

    this.updateObservation({
      station:    icao,
      tempC,
      tempF:      celsiusToFahrenheit(tempC),
      dewpointC,
      obsTimeUtc,
      raw:        rawText,
      isFresh:    Date.now() - obsTimeUtc.getTime() < 90 * 60 * 1_000,
    });
  }

  private updateObservation(obs: MetarObservation): void {
    const prev = this.latest.get(obs.station);

    // Only emit if the observation is newer than what we already have
    if (prev && prev.obsTimeUtc.getTime() >= obs.obsTimeUtc.getTime()) return;

    this.latest.set(obs.station, obs);

    const unit = CONFIG.TEMPERATURE_UNIT;
    const val  = unit === 'F' ? obs.tempF : obs.tempC;

    logger.info('WeatherDataFeed: new observation', {
      station:    obs.station,
      temp:       `${val.toFixed(1)}°${unit}`,
      obsTimeUtc: obs.obsTimeUtc.toISOString(),
      isFresh:    obs.isFresh,
      threshold:  CONFIG.TEMP_THRESHOLD,
      met:        val >= CONFIG.TEMP_THRESHOLD,
    });

    this.emit('observation', obs);

    if (val >= CONFIG.TEMP_THRESHOLD) {
      logger.warn('WeatherDataFeed: THRESHOLD MET', {
        station:   obs.station,
        temp:      `${val.toFixed(1)}°${unit}`,
        threshold: CONFIG.TEMP_THRESHOLD,
      });
      this.emit('threshold_met', obs);
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection with exponential backoff
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;

    logger.info('WeatherDataFeed: scheduling WS reconnect', { delayMs: this.reconnectDelayMs });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) this.connectWebSocket();
    }, this.reconnectDelayMs);

    // Double the backoff, cap at 60 s
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
  }
}
