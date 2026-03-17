/**
 * orderbook.ts
 * ============
 * Polymarket CLOB real-time order book monitor.
 *
 * The Polymarket CLOB exposes:
 *  - REST:      https://clob.polymarket.com/book?token_id=…
 *  - WebSocket: wss://clob.polymarket.com/ws (channel: "market")
 *
 * This module maintains a local best-effort replica of the live order book
 * for the target YES / NO token pair and exposes snapshot accessors used
 * by the EV calculator.
 *
 * WebSocket message format (Polymarket CLOB):
 * {
 *   "event_type": "book",
 *   "asset_id":   "71321045679252212594626385532706912750332728571942532289631379312455583992563",
 *   "market":     "0xabc…",
 *   "bids":       [{ "price": "0.92", "size": "150.00" }, …],
 *   "asks":       [{ "price": "0.94", "size": "80.00" }, …],
 *   "timestamp":  "1700000000000"
 * }
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

export interface PriceLevel {
  price: number;   // 0–1 (cents on the dollar), e.g. 0.93 = 93¢
  size:  number;   // USDC available at this tier
}

/** A full order book snapshot for one token */
export interface OrderBookSnapshot {
  tokenId:   string;
  bids:      PriceLevel[];   // sorted descending (highest bid first)
  asks:      PriceLevel[];   // sorted ascending  (lowest ask first)
  updatedAt: Date;
}

/** Raw level from the CLOB API/WS */
interface RawLevel { price: string; size: string }

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

function parseLevel(raw: RawLevel): PriceLevel {
  return {
    price: parseFloat(raw.price),
    size:  parseFloat(raw.size),
  };
}

function sortedBids(levels: PriceLevel[]): PriceLevel[] {
  return [...levels].sort((a, b) => b.price - a.price);
}

function sortedAsks(levels: PriceLevel[]): PriceLevel[] {
  return [...levels].sort((a, b) => a.price - b.price);
}

// ---------------------------------------------------------------------------
// OrderBookMonitor class
// ---------------------------------------------------------------------------

export class OrderBookMonitor extends EventEmitter {
  private ws:               WebSocket | null = null;
  private reconnectTimer:   NodeJS.Timeout | null = null;
  private destroyed:        boolean = false;
  private reconnectDelayMs: number  = 2_000;
  private readonly maxReconnectDelayMs = 30_000;

  /** Current best snapshot for each token we track */
  public readonly books: Map<string, OrderBookSnapshot> = new Map();

  get yesBook(): OrderBookSnapshot | undefined {
    return this.books.get(CONFIG.YES_TOKEN_ID);
  }

  get noBook(): OrderBookSnapshot | undefined {
    return this.books.get(CONFIG.NO_TOKEN_ID);
  }

  /** Best bid for NO token (highest price someone will pay for NO) */
  get noBestBid(): PriceLevel | undefined {
    return this.noBook?.bids[0];
  }

  /** Best ask for YES token (lowest price to buy YES) */
  get yesBestAsk(): PriceLevel | undefined {
    return this.yesBook?.asks[0];
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    logger.info('OrderBookMonitor: starting', {
      yesTokenId: CONFIG.YES_TOKEN_ID,
      noTokenId:  CONFIG.NO_TOKEN_ID,
    });

    // Seed with a REST snapshot so we have data before the WS connects
    await this.fetchRestSnapshot(CONFIG.YES_TOKEN_ID);
    await this.fetchRestSnapshot(CONFIG.NO_TOKEN_ID);

    this.connectWebSocket();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    logger.info('OrderBookMonitor: destroyed');
  }

  // -------------------------------------------------------------------------
  // WebSocket connection
  // -------------------------------------------------------------------------

  private connectWebSocket(): void {
    if (this.destroyed) return;

    logger.info('OrderBookMonitor: connecting WebSocket', { url: CONFIG.CLOB_WS_URL });

    this.ws = new WebSocket(CONFIG.CLOB_WS_URL);

    this.ws.on('open', () => {
      logger.info('OrderBookMonitor: WS connected');
      this.reconnectDelayMs = 2_000;

      // Subscribe to both YES and NO order books
      const sub = JSON.stringify({
        auth: {
          apiKey:     CONFIG.POLYMARKET_API_KEY,
          secret:     CONFIG.POLYMARKET_API_SECRET,
          passphrase: CONFIG.POLYMARKET_API_PASSPHRASE,
        },
        type:    'subscribe',
        channel: 'market',
        markets: [CONFIG.YES_TOKEN_ID, CONFIG.NO_TOKEN_ID],
      });
      this.ws!.send(sub);
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        this.handleMessage(data.toString());
      } catch (err) {
        logger.error('OrderBookMonitor: WS message error', { error: String(err) });
      }
    });

    this.ws.on('error', (err) => {
      logger.warn('OrderBookMonitor: WS error', { error: err.message });
      this.emit('error', err);
    });

    this.ws.on('close', (code, reason) => {
      logger.warn('OrderBookMonitor: WS closed', { code, reason: reason.toString() });
      this.ws = null;
      if (!this.destroyed) this.scheduleReconnect();
    });

    // Keepalive ping every 20 s
    const ping = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      } else {
        clearInterval(ping);
      }
    }, 20_000);
  }

  private handleMessage(raw: string): void {
    const msg = JSON.parse(raw) as Record<string, unknown>;

    // Ignore pong / ack frames
    if (msg['event_type'] === 'pong' || !msg['event_type']) return;

    // A "book" event is a full snapshot replacement
    if (msg['event_type'] === 'book') {
      const tokenId = msg['asset_id'] as string | undefined;
      if (!tokenId) return;

      const bids = (msg['bids'] as RawLevel[] ?? []).map(parseLevel);
      const asks = (msg['asks'] as RawLevel[] ?? []).map(parseLevel);

      this.updateBook(tokenId, bids, asks);
      return;
    }

    // A "price_change" event contains partial updates
    if (msg['event_type'] === 'price_change') {
      const changes = msg['changes'] as Array<{
        asset_id: string;
        side:     'BUY' | 'SELL';
        price:    string;
        size:     string;
      }> ?? [];

      for (const change of changes) {
        const tokenId = change.asset_id;
        const book    = this.books.get(tokenId);
        if (!book) continue;

        const level = parseLevel({ price: change.price, size: change.size });
        const side  = change.side === 'BUY' ? 'bids' : 'asks';

        // Remove the price tier if size drops to zero, otherwise upsert
        const levels = book[side].filter(l => l.price !== level.price);
        if (level.size > 0) levels.push(level);

        if (side === 'bids') {
          book.bids = sortedBids(levels);
        } else {
          book.asks = sortedAsks(levels);
        }
        book.updatedAt = new Date();
        this.emit('bookUpdate', tokenId, book);
      }
    }
  }

  private updateBook(tokenId: string, bids: PriceLevel[], asks: PriceLevel[]): void {
    const snapshot: OrderBookSnapshot = {
      tokenId,
      bids:      sortedBids(bids),
      asks:      sortedAsks(asks),
      updatedAt: new Date(),
    };
    this.books.set(tokenId, snapshot);

    logger.debug('OrderBookMonitor: book snapshot', {
      tokenId: tokenId.slice(0, 10) + '…',
      bestBid: snapshot.bids[0]?.price,
      bestAsk: snapshot.asks[0]?.price,
      bidLevels: snapshot.bids.length,
      askLevels: snapshot.asks.length,
    });

    this.emit('bookUpdate', tokenId, snapshot);
  }

  // -------------------------------------------------------------------------
  // REST snapshot (seed data + periodic reconciliation)
  // -------------------------------------------------------------------------

  async fetchRestSnapshot(tokenId: string): Promise<void> {
    const url  = `${CONFIG.CLOB_API_URL}/book`;

    const resp = await withRetry(
      () => axios.get<{ bids: RawLevel[]; asks: RawLevel[] }>(url, {
        params:  { token_id: tokenId },
        timeout: 8_000,
      }),
      { label: `CLOB REST book/${tokenId.slice(0, 8)}` },
    );

    const bids = (resp.data.bids ?? []).map(parseLevel);
    const asks = (resp.data.asks ?? []).map(parseLevel);
    this.updateBook(tokenId, bids, asks);
  }

  // -------------------------------------------------------------------------
  // Accessor: available liquidity up to a price ceiling
  // -------------------------------------------------------------------------

  /**
   * Returns total USDC-equivalent available on the BIDS side of `tokenId`
   * at or above `floorPrice` (bids we can sell into).
   *
   * @param tokenId    - Token to query
   * @param floorPrice - Only count bids ≥ this price (e.g. 0.90)
   * @param maxTiers   - Stop after this many price levels
   */
  availableBidLiquidity(
    tokenId:    string,
    floorPrice: number,
    maxTiers:   number = CONFIG.ORDER_BOOK_DEPTH,
  ): { totalUsdc: number; tiers: PriceLevel[] } {
    const book = this.books.get(tokenId);
    if (!book) return { totalUsdc: 0, tiers: [] };

    const tiers = book.bids
      .filter(b => b.price >= floorPrice)
      .slice(0, maxTiers);

    const totalUsdc = tiers.reduce((sum, t) => sum + t.price * t.size, 0);
    return { totalUsdc, tiers };
  }

  /**
   * Returns total USDC available on the ASKS side (i.e. tokens we can buy)
   * at or below `ceilingPrice`.
   */
  availableAskLiquidity(
    tokenId:      string,
    ceilingPrice: number,
    maxTiers:     number = CONFIG.ORDER_BOOK_DEPTH,
  ): { totalUsdc: number; tiers: PriceLevel[] } {
    const book = this.books.get(tokenId);
    if (!book) return { totalUsdc: 0, tiers: [] };

    const tiers = book.asks
      .filter(a => a.price <= ceilingPrice)
      .slice(0, maxTiers);

    const totalUsdc = tiers.reduce((sum, t) => sum + t.price * t.size, 0);
    return { totalUsdc, tiers };
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    logger.info('OrderBookMonitor: reconnecting in', { delayMs: this.reconnectDelayMs });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) this.connectWebSocket();
    }, this.reconnectDelayMs);

    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
  }
}
