/**
 * gas.ts
 * EIP-1559 dynamic gas pricing module.
 *
 * Strategy:
 *  1. Read the latest block's baseFeePerGas from the WebSocket provider.
 *  2. Apply a multiplier so our maxFeePerGas always sits above the next
 *     block's (potentially higher) base fee.
 *  3. Add an aggressive priority tip to outbid competing arbitrageurs.
 *
 * Polygon specifics:
 *  - Polygon uses EIP-1559 but its base fee adjusts much faster than
 *    Ethereum's.  A 1.5× multiplier on the current baseFee is aggressive
 *    but not wasteful; the chain refunds the unused portion.
 *  - Priority fees of 30–100 GWEI are normal on Polygon during congestion.
 */

import { ethers } from 'ethers';
import { CONFIG, GWEI } from './config';
import { logger } from './logger';

export interface GasPrices {
  maxFeePerGas:         bigint;  // EIP-1559 fee cap (baseFee × multiplier + tip)
  maxPriorityFeePerGas: bigint;  // Miner tip (GWEI)
  baseFee:              bigint;  // Current block baseFeePerGas (for logging)
}

/**
 * Fetch current EIP-1559 gas prices and compute aggressive values for
 * next-block inclusion.
 *
 * @param provider - A connected ethers WebSocketProvider (or JsonRpcProvider)
 * @returns GasPrices ready to spread into a transaction object
 */
export async function getAggressiveGasPrice(
  provider: ethers.WebSocketProvider | ethers.JsonRpcProvider,
): Promise<GasPrices> {
  const block = await provider.getBlock('latest');
  if (!block) throw new Error('gas.ts: getBlock returned null');

  const baseFee = block.baseFeePerGas;
  if (baseFee === null || baseFee === undefined) {
    // Fallback for non-EIP-1559 blocks (should never happen on Polygon mainnet)
    throw new Error('gas.ts: block.baseFeePerGas is null — not an EIP-1559 block');
  }

  // Multiply baseFee by CONFIG.BASE_FEE_MULTIPLIER using integer arithmetic.
  // e.g. 1.5× → multiply by 15, divide by 10.
  const multiplierNumerator   = BigInt(Math.round(CONFIG.BASE_FEE_MULTIPLIER * 10));
  const multiplierDenominator = 10n;
  const scaledBase            = (baseFee * multiplierNumerator) / multiplierDenominator;

  const priorityFee    = BigInt(Math.round(CONFIG.PRIORITY_FEE_GWEI)) * GWEI;
  const maxFeePerGas   = scaledBase + priorityFee;

  logger.debug('Gas prices computed', {
    baseFee:              ethers.formatUnits(baseFee, 'gwei')  + ' GWEI',
    scaledBase:           ethers.formatUnits(scaledBase, 'gwei') + ' GWEI',
    priorityFee:          ethers.formatUnits(priorityFee, 'gwei') + ' GWEI',
    maxFeePerGas:         ethers.formatUnits(maxFeePerGas, 'gwei') + ' GWEI',
    maxPriorityFeePerGas: ethers.formatUnits(priorityFee, 'gwei') + ' GWEI',
  });

  return {
    maxFeePerGas,
    maxPriorityFeePerGas: priorityFee,
    baseFee,
  };
}

/**
 * Wait for a transaction to be mined, optionally monitoring for replacement
 * (in case a higher-gas-price tx supersedes it).
 *
 * @param tx       - Pending transaction response
 * @param confirms - Number of confirmations to wait for (1 is enough for arb)
 * @param timeout  - Max milliseconds to wait before throwing
 */
export async function waitForTransaction(
  tx: ethers.TransactionResponse,
  confirms = 1,
  timeout  = 30_000,
): Promise<ethers.TransactionReceipt> {
  logger.info('Waiting for tx', { hash: tx.hash, confirms });

  const receipt = await Promise.race([
    tx.wait(confirms),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tx ${tx.hash} timed out after ${timeout}ms`)), timeout),
    ),
  ]);

  if (!receipt) throw new Error(`Tx ${tx.hash} wait() returned null`);

  if (receipt.status === 0) {
    throw new Error(`Tx ${tx.hash} reverted on-chain. Gas used: ${receipt.gasUsed}`);
  }

  logger.info('Tx confirmed', {
    hash:      tx.hash,
    block:     receipt.blockNumber,
    gasUsed:   receipt.gasUsed.toString(),
    confirms,
  });

  return receipt;
}

/**
 * Exponential-backoff retry wrapper for any async operation.
 * Used around RPC calls and HTTP requests that can transiently fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    attempts  = 4,
    baseDelay = 2_000,
    label     = 'operation',
  }: { attempts?: number; baseDelay?: number; label?: string } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = baseDelay * Math.pow(2, attempt - 1);  // 2s, 4s, 8s, 16s
      logger.warn(`${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms`, {
        error: String(err),
      });
      if (attempt < attempts) await sleep(delay);
    }
  }
  throw lastErr;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
