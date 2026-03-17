/**
 * ev_calculator.ts
 * ================
 * Expected Value (EV) calculation and slippage-protection engine.
 *
 * Strategy: "Split and Sell NO"
 * ──────────────────────────────
 *  1. We deposit X USDC.e into the CTF contract.
 *  2. We receive X YES tokens + X NO tokens (each token worth $1 at resolution).
 *  3. We immediately sell the NO tokens on the CLOB at the best available bid.
 *  4. The net cost of our YES position = X USDC spent − proceeds from selling NO.
 *
 * EV analysis:
 *  - "True probability" of YES resolving = 0.99 (threshold definitively met).
 *  - If NO token sells at price P_NO, effective cost of YES = (1 − P_NO).
 *  - EV per dollar risked = 0.99 × 1 − (1 − P_NO) = P_NO − 0.01
 *  - We require EV edge ≥ CONFIG.MIN_EV_EDGE before trading.
 *
 * Slippage protection:
 *  - We walk the bid ladder for NO tokens and compute the volume-weighted
 *    average price (VWAP) across as many tiers as our position size requires.
 *  - If the VWAP falls below our break-even, we abort.
 *  - If our order would consume > CONFIG.MAX_SLIPPAGE_FRACTION of available
 *    liquidity, we size down or abort.
 */

import Decimal from 'decimal.js';
import { CONFIG } from './config';
import { logger } from './logger';
import type { OrderBookSnapshot, PriceLevel } from './orderbook';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EVResult {
  shouldTrade:        boolean;
  reason:             string;

  // Economics (all in USDC)
  usdcToSplit:        number;   // amount to deposit into CTF
  noTokensToSell:     number;   // = usdcToSplit (1:1 mint ratio)
  estimatedNoProceeds:number;   // USDC received selling NO at VWAP
  effectiveYesCost:   number;   // usdcToSplit − estimatedNoProceeds
  evPerDollar:        number;   // expected profit per dollar of effective YES cost
  evAbsolute:         number;   // evPerDollar × effectiveYesCost

  // Order book details
  vwapNo:             number;   // volume-weighted avg price for NO sale
  liquidityUsed:      number;   // fraction of available NO bid liquidity consumed
  tiersConsumed:      PriceLevel[];
}

// ---------------------------------------------------------------------------
// Core calculation
// ---------------------------------------------------------------------------

/**
 * Calculate whether an arbitrage trade is viable given the current market state.
 *
 * @param noBook        - Current NO token order book
 * @param trueProbYes   - Our edge-computed probability that YES resolves (0–1)
 * @param maxUsdcBudget - Maximum USDC we're willing to deploy this cycle
 */
export function calculateEV(
  noBook:        OrderBookSnapshot,
  trueProbYes:   number,
  maxUsdcBudget: number,
): EVResult {
  const D = Decimal;

  // Guard: order book must be fresh (< 5 seconds old)
  const ageSec = (Date.now() - noBook.updatedAt.getTime()) / 1_000;
  if (ageSec > 5) {
    logger.warn('EV: order book too stale', { ageSec });
    return noTrade('Order book data is stale (> 5 seconds)');
  }

  // Collect bids (people willing to BUY our NO tokens) above break-even.
  // Break-even bid = 1 − true_prob_yes − min_edge
  //   e.g. if true prob = 0.99, edge = 0.03 → min bid we'll accept = 0.08
  //   But we actually want: sell_proceeds > (1 − true_prob) so any sell
  //   above (1 − 0.99) = 0.01 is technically +EV.  We add the MIN_EV_EDGE
  //   as a buffer for transaction costs.
  const trueP      = new D(trueProbYes);
  const minBidPrice = new D(1)
    .minus(trueP)
    .plus(new D(CONFIG.MIN_EV_EDGE));         // e.g. 0.01 + 0.03 = 0.04

  // Filter bids above our floor
  const eligibleBids = noBook.bids
    .filter(b => new D(b.price).gte(minBidPrice))
    .slice(0, CONFIG.ORDER_BOOK_DEPTH);

  if (eligibleBids.length === 0) {
    return noTrade(
      `No NO bids above minimum price ${minBidPrice.toFixed(4)} ` +
      `(need P_NO ≥ ${minBidPrice.toFixed(4)} for ${CONFIG.MIN_EV_EDGE*100}% edge)`
    );
  }

  // Total available liquidity (in token terms) at these bids
  const totalAvailableTokens = eligibleBids.reduce((s, b) => s + b.size, 0);

  // Determine position size — limited by budget AND available liquidity
  // We also cap at MAX_SLIPPAGE_FRACTION of total book liquidity
  const maxBySlippage = totalAvailableTokens * CONFIG.MAX_SLIPPAGE_FRACTION;
  const tokensToSell  = Math.min(maxUsdcBudget, maxBySlippage, totalAvailableTokens);

  if (tokensToSell < 1) {
    return noTrade(
      `Insufficient NO bid liquidity: ${totalAvailableTokens.toFixed(2)} tokens, ` +
      `slippage cap: ${maxBySlippage.toFixed(2)}`
    );
  }

  // Walk the order book to compute VWAP and consumed tiers
  let remaining      = tokensToSell;
  let totalProceeds  = 0;
  const tiersConsumed: PriceLevel[] = [];

  for (const bid of eligibleBids) {
    if (remaining <= 0) break;
    const fill = Math.min(remaining, bid.size);
    totalProceeds += fill * bid.price;
    remaining     -= fill;
    tiersConsumed.push({ price: bid.price, size: fill });
  }

  if (remaining > 0.01) {
    // Couldn't fill the full size — this shouldn't happen given our cap above
    // but handle it gracefully by trading only what we can
    logger.warn('EV: partial book fill', {
      requested: tokensToSell,
      filled:    tokensToSell - remaining,
    });
  }

  const actualTokensSold  = tokensToSell - remaining;
  const vwapNo            = totalProceeds / actualTokensSold;
  const liquidityUsed     = actualTokensSold / totalAvailableTokens;

  // Final checks
  if (liquidityUsed > CONFIG.MAX_SLIPPAGE_FRACTION) {
    return noTrade(
      `Would consume ${(liquidityUsed * 100).toFixed(1)}% of book ` +
      `(max: ${CONFIG.MAX_SLIPPAGE_FRACTION * 100}%)`
    );
  }

  // EV calculation
  // After splitting X USDC → X YES + X NO tokens:
  //   Sell NO at VWAP → proceeds = X × vwapNo
  //   Effective YES cost = X − X×vwapNo = X×(1 − vwapNo)
  //   Expected payout of YES = X × trueProbYes
  //   EV = X×trueProbYes − X×(1−vwapNo) = X×(trueProbYes + vwapNo − 1)
  //   EV per dollar of YES cost = (trueProbYes + vwapNo − 1) / (1 − vwapNo)
  const usdcToSplit           = actualTokensSold;   // 1 USDC → 1 YES + 1 NO
  const estimatedNoProceeds   = totalProceeds;
  const effectiveYesCost      = usdcToSplit - estimatedNoProceeds;

  if (effectiveYesCost <= 0) {
    // Extremely rare: NO bids > 1 → arbitrage with guaranteed profit just from split
    logger.warn('EV: negative YES cost — instant arb, but verify data integrity');
  }

  const evPerDollar = trueProbYes + vwapNo - 1;
  const evAbsolute  = evPerDollar * usdcToSplit;

  const shouldTrade = evPerDollar >= CONFIG.MIN_EV_EDGE;

  const result: EVResult = {
    shouldTrade,
    reason:               shouldTrade ? 'Positive EV above threshold' : `EV ${evPerDollar.toFixed(4)} < min ${CONFIG.MIN_EV_EDGE}`,
    usdcToSplit,
    noTokensToSell:       actualTokensSold,
    estimatedNoProceeds,
    effectiveYesCost,
    evPerDollar,
    evAbsolute,
    vwapNo,
    liquidityUsed,
    tiersConsumed,
  };

  logger.info('EV calculation', {
    shouldTrade,
    usdcToSplit:          usdcToSplit.toFixed(2),
    vwapNo:               vwapNo.toFixed(4),
    estimatedNoProceeds:  estimatedNoProceeds.toFixed(2),
    effectiveYesCost:     effectiveYesCost.toFixed(2),
    evPerDollar:          evPerDollar.toFixed(4),
    evAbsolute:           evAbsolute.toFixed(2),
    liquidityUsed:        `${(liquidityUsed * 100).toFixed(1)}%`,
    tiersConsumed:        tiersConsumed.length,
    reason:               result.reason,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noTrade(reason: string): EVResult {
  logger.info('EV: no trade', { reason });
  return {
    shouldTrade:         false,
    reason,
    usdcToSplit:         0,
    noTokensToSell:      0,
    estimatedNoProceeds: 0,
    effectiveYesCost:    0,
    evPerDollar:         0,
    evAbsolute:          0,
    vwapNo:              0,
    liquidityUsed:       0,
    tiersConsumed:       [],
  };
}

/**
 * Computes the "true probability" from weather observation data.
 * Once the temperature threshold is definitively met by a fresh official
 * observation, we assign 0.99 (not 1.0 to account for resolution edge cases
 * such as station errors or disputed readings).
 *
 * @param thresholdMet - Flag from WeatherDataFeed
 * @param isFresh      - The observation is < 90 minutes old
 * @param staleHours   - How many hours old the reading is (penalises staleness)
 */
export function computeTrueProbability(
  thresholdMet: boolean,
  isFresh:      boolean,
  staleHours:   number = 0,
): number {
  if (!thresholdMet) return 0;

  // Stale observation: reduce confidence linearly up to 4 hours
  if (!isFresh) {
    const stalePenalty = Math.min(staleHours / 4, 0.20);   // max 20% reduction
    return Math.max(0.79, 0.99 - stalePenalty);
  }

  return 0.99;
}
