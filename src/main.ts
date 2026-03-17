/**
 * main.ts
 * =======
 * Bot orchestrator — ties together all subsystems and runs the main
 * arbitrage loop.
 *
 * Lifecycle:
 * ──────────
 *  1. Validate environment and connect providers.
 *  2. Start WeatherDataFeed (WS + polling fallback).
 *  3. Start OrderBookMonitor (WS + REST seed).
 *  4. Listen for threshold_met events from the weather feed.
 *  5. On each event, run the EV check.
 *  6. If shouldTrade, execute.
 *  7. Enforce cooldown between trades to avoid repeat firing.
 *  8. Graceful shutdown on SIGINT / SIGTERM.
 *
 * Re-entry protection:
 *  A single `isTrading` flag prevents concurrent executions if multiple
 *  threshold events fire in quick succession.
 */

import { ethers }            from 'ethers';
import { CONFIG }            from './config';
import { logger }            from './logger';
import { WeatherDataFeed, MetarObservation } from './data_feed';
import { OrderBookMonitor }  from './orderbook';
import { calculateEV, computeTrueProbability } from './ev_calculator';
import { TradeExecutor }     from './execution';
import { sleep, withRetry }  from './gas';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let provider:    ethers.WebSocketProvider | null = null;
let feed:        WeatherDataFeed | null = null;
let monitor:     OrderBookMonitor | null = null;
let executor:    TradeExecutor | null = null;

let isTrading    = false;
let lastTradeAt  = 0;
const COOLDOWN_MS = 60_000;    // minimum 60 s between trades on same signal

// ---------------------------------------------------------------------------
// Provider management
// ---------------------------------------------------------------------------

async function createProvider(): Promise<ethers.WebSocketProvider> {
  logger.info('Connecting to Polygon RPC', { url: CONFIG.POLYGON_WSS_URL.replace(/\/[^\/]+$/, '/***') });

  const prov = new ethers.WebSocketProvider(CONFIG.POLYGON_WSS_URL);

  // Verify connectivity
  const network = await withRetry(
    () => prov.getNetwork(),
    { label: 'provider network check' },
  );

  if (Number(network.chainId) !== 137) {
    throw new Error(`Wrong network: expected Polygon (137), got ${network.chainId}`);
  }

  logger.info('Polygon RPC connected', { chainId: network.chainId.toString(), name: network.name });

  // Handle provider errors — attempt reconnect
  prov.websocket.addEventListener('close', async () => {
    logger.warn('RPC WebSocket closed — attempting reconnect in 5 s');
    await sleep(5_000);
    if (provider) {
      try {
        provider = await createProvider();
        if (executor) executor = new TradeExecutor(provider);
      } catch (err) {
        logger.error('Provider reconnect failed', { error: String(err) });
      }
    }
  });

  return prov;
}

// ---------------------------------------------------------------------------
// Core trade evaluation + execution
// ---------------------------------------------------------------------------

async function evaluateAndTrade(obs: MetarObservation): Promise<void> {
  // Re-entry guard
  if (isTrading) {
    logger.debug('Trade already in flight — skipping');
    return;
  }

  // Cooldown guard
  const msSinceLast = Date.now() - lastTradeAt;
  if (lastTradeAt > 0 && msSinceLast < COOLDOWN_MS) {
    logger.debug('In cooldown', { msSinceLast, cooldownMs: COOLDOWN_MS });
    return;
  }

  // Sanity: order book must be populated
  if (!monitor?.noBook) {
    logger.warn('No order book data yet — skipping');
    return;
  }

  // Sanity: wallet balance
  const usdcBal  = await executor!.usdcBalance();
  const maticBal = await executor!.maticBalance();

  logger.info('Wallet balances', {
    usdc:  usdcBal.toFixed(2),
    matic: maticBal.toFixed(4),
  });

  if (usdcBal < 1) {
    logger.warn('Insufficient USDC balance', { usdcBal });
    return;
  }

  if (maticBal < 0.5) {
    logger.warn('Low MATIC balance for gas', { maticBal });
    return;
  }

  // Compute true probability from observation freshness
  const staleHours = (Date.now() - obs.obsTimeUtc.getTime()) / 3_600_000;
  const trueProb   = computeTrueProbability(
    feed!.thresholdMet,
    obs.isFresh,
    staleHours,
  );

  if (trueProb < 0.8) {
    logger.warn('True probability too low — stale data?', { trueProb, staleHours });
    return;
  }

  // Budget: min of configured max and current balance
  const budget = Math.min(CONFIG.MAX_POSITION_USDC, usdcBal * 0.95);  // keep 5% buffer

  // EV calculation
  const ev = calculateEV(monitor.noBook, trueProb, budget);

  if (!ev.shouldTrade) {
    logger.info('No trade signal', { reason: ev.reason });
    return;
  }

  // === TRADE ===
  isTrading = true;
  try {
    logger.warn('TRADE SIGNAL — executing', {
      usdcToSplit:      ev.usdcToSplit.toFixed(2),
      evPerDollar:      ev.evPerDollar.toFixed(4),
      vwapNo:           ev.vwapNo.toFixed(4),
    });

    const result = await executor!.execute(ev);

    if (result.success) {
      lastTradeAt = Date.now();
      logger.warn('TRADE COMPLETED', {
        orderId:    result.orderId,
        fillPrice:  result.fillPrice?.toFixed(4),
        fillAmount: result.fillAmount?.toFixed(2),
      });
    } else {
      logger.error('TRADE FAILED', { error: result.error });
    }
  } finally {
    isTrading = false;
  }
}

// ---------------------------------------------------------------------------
// Startup health check
// ---------------------------------------------------------------------------

async function printStartupBanner(): Promise<void> {
  console.log('\n' + '═'.repeat(60));
  console.log('  POLYMARKET HFT WEATHER ARBITRAGE BOT');
  console.log('═'.repeat(60));
  console.log(`  Market condition: ${CONFIG.CONDITION_ID.slice(0, 18)}…`);
  console.log(`  Stations:         ${CONFIG.METAR_STATIONS.join(', ')}`);
  console.log(`  Threshold:        ${CONFIG.TEMP_THRESHOLD}°${CONFIG.TEMPERATURE_UNIT}`);
  console.log(`  Max position:     $${CONFIG.MAX_POSITION_USDC} USDC`);
  console.log(`  Min EV edge:      ${(CONFIG.MIN_EV_EDGE * 100).toFixed(1)}%`);
  console.log(`  Max slippage:     ${(CONFIG.MAX_SLIPPAGE_FRACTION * 100).toFixed(0)}%`);
  console.log(`  Priority fee:     ${CONFIG.PRIORITY_FEE_GWEI} GWEI`);
  console.log('═'.repeat(60) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await printStartupBanner();

  logger.info('Initialising bot…');

  // 1. Connect RPC provider
  provider = await createProvider();

  // 2. Initialise executor (needs provider for gas estimates)
  executor = new TradeExecutor(provider);

  // 3. Log starting balances
  const usdcBal  = await executor.usdcBalance();
  const maticBal = await executor.maticBalance();
  logger.info('Starting balances', {
    usdc:    usdcBal.toFixed(2),
    matic:   maticBal.toFixed(4),
    address: new ethers.Wallet(CONFIG.PRIVATE_KEY).address,
  });

  // 4. Start weather feed
  feed = new WeatherDataFeed();

  feed.on('observation', (obs: MetarObservation) => {
    const unit = CONFIG.TEMPERATURE_UNIT;
    const temp = unit === 'F' ? obs.tempF : obs.tempC;
    logger.debug('Observation received', {
      station: obs.station,
      temp:    `${temp.toFixed(1)}°${unit}`,
      fresh:   obs.isFresh,
    });
  });

  feed.on('threshold_met', (obs: MetarObservation) => {
    logger.warn('Weather threshold met — evaluating trade opportunity', {
      station:   obs.station,
      threshold: CONFIG.TEMP_THRESHOLD,
      unit:      CONFIG.TEMPERATURE_UNIT,
    });
    // Fire and forget — errors are caught inside evaluateAndTrade
    evaluateAndTrade(obs).catch(err =>
      logger.error('evaluateAndTrade threw', { error: String(err) })
    );
  });

  feed.on('error', (err: Error) => {
    logger.warn('WeatherDataFeed error', { error: err.message });
  });

  await feed.start();

  // 5. Start order book monitor
  monitor = new OrderBookMonitor();

  monitor.on('bookUpdate', (tokenId: string) => {
    logger.debug('Book updated', { tokenId: tokenId.slice(0, 12) + '…' });

    // If temperature threshold is already met when the book updates,
    // re-evaluate in case better liquidity just arrived
    if (feed?.thresholdMet && !isTrading) {
      const latest = [...feed.latest.values()].find(o => o.isFresh);
      if (latest) {
        evaluateAndTrade(latest).catch(err =>
          logger.error('bookUpdate evaluateAndTrade threw', { error: String(err) })
        );
      }
    }
  });

  monitor.on('error', (err: Error) => {
    logger.warn('OrderBookMonitor error', { error: err.message });
  });

  await monitor.start();

  // 6. Periodic heartbeat log every 5 minutes
  setInterval(async () => {
    const unit    = CONFIG.TEMPERATURE_UNIT;
    const maxTemp = feed?.maxTempToday ?? -Infinity;
    const met     = feed?.thresholdMet ?? false;

    const bal = await executor!.usdcBalance().catch(() => -1);

    logger.info('Heartbeat', {
      maxTemp:      `${maxTemp.toFixed(1)}°${unit}`,
      thresholdMet: met,
      usdcBalance:  bal.toFixed(2),
      isTrading,
      lastTradeAt:  lastTradeAt ? new Date(lastTradeAt).toISOString() : 'never',
    });
  }, 5 * 60 * 1_000);

  logger.info('Bot is running. Waiting for weather threshold signal…');

  // 7. Keep process alive
  await new Promise<void>((_, reject) => {
    process.on('SIGINT',  () => reject(new Error('SIGINT')));
    process.on('SIGTERM', () => reject(new Error('SIGTERM')));
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(reason: string): Promise<void> {
  logger.info('Shutting down', { reason });

  feed?.destroy();
  monitor?.destroy();

  if (provider) {
    try {
      await provider.destroy();
    } catch (_) { /* ignore */ }
    provider = null;
  }

  logger.info('Shutdown complete');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main()
  .catch(async (err) => {
    const msg = String(err?.message ?? err);
    if (msg === 'SIGINT' || msg === 'SIGTERM') {
      await shutdown(msg);
      process.exit(0);
    } else {
      logger.error('Fatal error in main()', { error: msg, stack: err?.stack });
      await shutdown('fatal error');
      process.exit(1);
    }
  });
