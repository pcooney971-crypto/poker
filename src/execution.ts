/**
 * execution.ts
 * ============
 * On-chain execution layer: interacts directly with Polymarket's smart
 * contracts to implement the "Split and Sell NO" arbitrage strategy.
 *
 * Protocol flow:
 * ─────────────
 * Step A — APPROVE
 *   Ensure the CTF contract has a USDC.e allowance ≥ our position size.
 *   (Only issues a new on-chain approve if the current allowance is too low.)
 *
 * Step B — SPLIT
 *   Call CTF.splitPosition(USDC, 0x00, conditionId, [1,2], amount)
 *   This mints 1 YES token (indexSet 1) and 1 NO token (indexSet 2)
 *   for every 1 USDC.e deposited.  Token IDs are deterministic ERC-1155 IDs.
 *
 * Step C — PLACE LIMIT MAKER ORDER (sell NO via CLOB API)
 *   Sign a limit sell order for NO tokens at the best available bid price.
 *   Submit through the Polymarket CLOB REST API (off-chain order signature,
 *   on-chain settlement).
 *
 * Step D — MONITOR
 *   Poll order status until filled, cancelled, or timed out.
 *   If partially filled, cancel the remainder (don't leave open risk).
 *
 * The YES tokens remain in the wallet at their superior cost basis.
 *
 * On-chain signing (EIP-712)
 * ──────────────────────────
 * Polymarket's CTF Exchange uses EIP-712 typed data signatures.  We build
 * and sign the Order struct off-chain, then POST it to the CLOB REST API.
 * The exchange contract verifies the signature on-chain when a counterparty
 * fills it (maker-taker model).
 */

import { ethers } from 'ethers';
import axios from 'axios';
import { CONFIG, USDC_DECIMALS, GWEI } from './config';
import { logger, tradeLogger } from './logger';
import { getAggressiveGasPrice, waitForTransaction, withRetry } from './gas';
import type { EVResult } from './ev_calculator';

import CTF_ABI     from '../abis/CTF.json';
import USDC_ABI    from '../abis/USDCe.json';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Polymarket CTF condition partition: [1, 2] = [YES index set, NO index set]
const PARTITION_YES_NO = [1n, 2n];

// bytes32 zero — parent collection for a root-level condition
const BYTES32_ZERO = ethers.ZeroHash;

// Order expiration: 10 minutes from now (in seconds since epoch)
const ORDER_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  success:       boolean;
  splitTxHash?:  string;
  orderId?:      string;
  fillPrice?:    number;
  fillAmount?:   number;   // USDC proceeds from NO sale
  error?:        string;
}

interface ClobOrderRequest {
  order:     ClobOrder;
  owner:     string;           // maker address
  orderType: 'GTC' | 'GTD' | 'FOK';
}

interface ClobOrder {
  salt:          string;
  maker:         string;
  signer:        string;
  taker:         string;       // zero address for open orders
  tokenId:       string;       // NO token ERC-1155 ID
  makerAmount:   string;       // tokens to sell (18 decimals for CTF tokens)
  takerAmount:   string;       // USDC to receive (6 decimals)
  expiration:    string;       // Unix timestamp
  nonce:         string;
  feeRateBps:    string;       // e.g. "0" (maker pays 0 fee on Polymarket)
  side:          string;       // "1" = SELL
  signatureType: string;       // "0" = EOA
  signature:     string;
}

// ---------------------------------------------------------------------------
// Executor class
// ---------------------------------------------------------------------------

export class TradeExecutor {
  private readonly provider: ethers.WebSocketProvider;
  private readonly wallet:   ethers.Wallet;
  private readonly usdc:     ethers.Contract;
  private readonly ctf:      ethers.Contract;

  constructor(provider: ethers.WebSocketProvider) {
    this.provider = provider;
    this.wallet   = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);

    this.usdc = new ethers.Contract(CONFIG.USDC_CONTRACT, USDC_ABI, this.wallet);
    this.ctf  = new ethers.Contract(CONFIG.CTF_CONTRACT,  CTF_ABI,  this.wallet);

    logger.info('TradeExecutor: initialised', { address: this.wallet.address });
  }

  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------

  /**
   * Execute the full "Split and Sell NO" arbitrage cycle.
   *
   * @param ev - Output from calculateEV(); must have shouldTrade = true
   */
  async execute(ev: EVResult): Promise<ExecutionResult> {
    if (!ev.shouldTrade) {
      return { success: false, error: 'execute() called with shouldTrade=false' };
    }

    const traceId = Date.now().toString(36);
    logger.info('Execution: starting', {
      traceId,
      usdcToSplit:      ev.usdcToSplit.toFixed(2),
      estimatedProceeds: ev.estimatedNoProceeds.toFixed(2),
      evAbsolute:        ev.evAbsolute.toFixed(2),
    });

    try {
      // ── Step A: ensure USDC allowance ──────────────────────────────────
      await this.ensureAllowance(ev.usdcToSplit);

      // ── Step B: split USDC → YES + NO ──────────────────────────────────
      const splitTxHash = await this.splitPosition(ev.usdcToSplit);

      // ── Step C: place limit sell order for NO ──────────────────────────
      const { orderId, targetPrice } = await this.placeNoSellOrder(
        ev.noTokensToSell,
        ev.vwapNo,
        ev.tiersConsumed[0]?.price ?? ev.vwapNo,
      );

      // ── Step D: monitor order until filled or expired ──────────────────
      const fillResult = await this.monitorOrder(orderId, ev.noTokensToSell, ORDER_TTL_SECONDS);

      const result: ExecutionResult = {
        success:     fillResult.filled > 0,
        splitTxHash,
        orderId,
        fillPrice:   fillResult.avgPrice,
        fillAmount:  fillResult.proceeds,
      };

      tradeLogger.info('Trade executed', {
        traceId,
        ...result,
        usdcDeployed:   ev.usdcToSplit,
        targetNoPrice:  targetPrice,
        evPerDollar:    ev.evPerDollar,
        evAbsolute:     ev.evAbsolute,
        timestamp:      new Date().toISOString(),
      });

      logger.info('Execution: complete', result);
      return result;

    } catch (err) {
      const error = String(err);
      logger.error('Execution: FAILED', { traceId, error });
      tradeLogger.error('Trade failed', { traceId, error, timestamp: new Date().toISOString() });
      return { success: false, error };
    }
  }

  // -------------------------------------------------------------------------
  // Step A: USDC allowance
  // -------------------------------------------------------------------------

  private async ensureAllowance(usdcAmount: number): Promise<void> {
    const amountBN = BigInt(Math.ceil(usdcAmount * 10 ** USDC_DECIMALS));

    const current: bigint = await withRetry(
      () => this.usdc.allowance(this.wallet.address, CONFIG.CTF_CONTRACT) as Promise<bigint>,
      { label: 'USDC allowance check' },
    );

    if (current >= amountBN) {
      logger.debug('Allowance sufficient', { current: current.toString(), needed: amountBN.toString() });
      return;
    }

    logger.info('Approving USDC for CTF', { amount: usdcAmount.toFixed(2) });

    const gas = await getAggressiveGasPrice(this.provider);

    const tx: ethers.TransactionResponse = await withRetry(
      () => this.usdc.approve(CONFIG.CTF_CONTRACT, amountBN, {
        maxFeePerGas:         gas.maxFeePerGas,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
        gasLimit:             100_000n,
      }) as Promise<ethers.TransactionResponse>,
      { label: 'USDC approve tx' },
    );

    await waitForTransaction(tx);
    logger.info('USDC approved', { txHash: tx.hash, amount: usdcAmount.toFixed(2) });
  }

  // -------------------------------------------------------------------------
  // Step B: Split position
  // -------------------------------------------------------------------------

  private async splitPosition(usdcAmount: number): Promise<string> {
    const amountBN = BigInt(Math.ceil(usdcAmount * 10 ** USDC_DECIMALS));

    logger.info('Splitting position', {
      usdc:        usdcAmount.toFixed(2),
      conditionId: CONFIG.CONDITION_ID,
    });

    const gas = await getAggressiveGasPrice(this.provider);

    const tx: ethers.TransactionResponse = await withRetry(
      () => this.ctf.splitPosition(
        CONFIG.USDC_CONTRACT,
        BYTES32_ZERO,
        CONFIG.CONDITION_ID,
        PARTITION_YES_NO,
        amountBN,
        {
          maxFeePerGas:         gas.maxFeePerGas,
          maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
          gasLimit:             CONFIG.GAS_LIMIT_SPLIT,
        },
      ) as Promise<ethers.TransactionResponse>,
      { label: 'CTF splitPosition tx' },
    );

    const receipt = await waitForTransaction(tx);

    logger.info('Position split', {
      txHash:   tx.hash,
      block:    receipt.blockNumber,
      gasUsed:  receipt.gasUsed.toString(),
      yesTokens: usdcAmount.toFixed(2),
      noTokens:  usdcAmount.toFixed(2),
    });

    return tx.hash;
  }

  // -------------------------------------------------------------------------
  // Step C: Place limit maker order on CLOB (sell NO tokens)
  // -------------------------------------------------------------------------

  private async placeNoSellOrder(
    noTokenAmount: number,
    vwapPrice:     number,
    bestBidPrice:  number,
  ): Promise<{ orderId: string; targetPrice: number }> {
    // Use the best bid price (not VWAP) for the limit order.
    // This ensures we land at the TOP of the book as a maker.
    // If not filled quickly at this price, we can re-price downward.
    const targetPrice = bestBidPrice;

    // CTF tokens use 18 decimals (ERC-1155 but consistent with ERC-20 precision)
    const makerAmountBN = BigInt(Math.floor(noTokenAmount * 1e18));

    // USDC proceeds we expect = noTokens × targetPrice (6 decimals for USDC)
    const takerAmountBN = BigInt(Math.floor(noTokenAmount * targetPrice * 10 ** USDC_DECIMALS));

    const expiration = BigInt(Math.floor(Date.now() / 1000) + ORDER_TTL_SECONDS);
    const salt       = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    const nonce      = 0n;

    const rawOrder = {
      salt:          salt.toString(),
      maker:         this.wallet.address,
      signer:        this.wallet.address,
      taker:         ethers.ZeroAddress,
      tokenId:       CONFIG.NO_TOKEN_ID,
      makerAmount:   makerAmountBN.toString(),
      takerAmount:   takerAmountBN.toString(),
      expiration:    expiration.toString(),
      nonce:         nonce.toString(),
      feeRateBps:    '0',
      side:          '1',            // SELL
      signatureType: '0',            // EOA
    };

    // Build EIP-712 signature
    const signature = await this.signClobOrder(rawOrder);

    const orderRequest: ClobOrderRequest = {
      order:     { ...rawOrder, signature },
      owner:     this.wallet.address,
      orderType: 'GTC',
    };

    logger.info('Placing CLOB sell order for NO', {
      noTokenAmount: noTokenAmount.toFixed(4),
      targetPrice:   targetPrice.toFixed(4),
      usdcExpected:  (noTokenAmount * targetPrice).toFixed(2),
      expiration:    new Date(Number(expiration) * 1000).toISOString(),
    });

    const resp = await withRetry(
      () => axios.post<{ orderID: string }>(
        `${CONFIG.CLOB_API_URL}/order`,
        orderRequest,
        {
          headers: this.clobAuthHeaders(),
          timeout: 10_000,
        },
      ),
      { label: 'CLOB order placement' },
    );

    const orderId = resp.data.orderID;
    logger.info('CLOB order placed', { orderId, targetPrice });

    return { orderId, targetPrice };
  }

  // -------------------------------------------------------------------------
  // Step D: Monitor order
  // -------------------------------------------------------------------------

  private async monitorOrder(
    orderId:      string,
    tokenAmount:  number,
    ttlSeconds:   number,
  ): Promise<{ filled: number; avgPrice: number; proceeds: number }> {
    const deadline = Date.now() + ttlSeconds * 1_000;
    let   totalFilled   = 0;
    let   totalProceeds = 0;

    logger.info('Monitoring CLOB order', { orderId, ttlSeconds });

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3_000));   // poll every 3 s

      const status = await withRetry(
        () => axios.get<{
          status:        string;
          size_matched:  string;
          price:         string;
        }>(`${CONFIG.CLOB_API_URL}/order/${orderId}`, {
          headers: this.clobAuthHeaders(),
          timeout: 8_000,
        }),
        { label: 'CLOB order status poll' },
      );

      const { status: orderStatus, size_matched, price } = status.data;

      if (orderStatus === 'FILLED') {
        totalFilled   = parseFloat(size_matched);
        const avgPrice = parseFloat(price);
        totalProceeds  = totalFilled * avgPrice;

        logger.info('CLOB order FILLED', {
          orderId, totalFilled, avgPrice, totalProceeds: totalProceeds.toFixed(2),
        });
        break;
      }

      if (orderStatus === 'CANCELLED' || orderStatus === 'EXPIRED') {
        logger.warn('CLOB order cancelled/expired early', { orderId, orderStatus });
        break;
      }

      const matched = parseFloat(size_matched || '0');
      logger.debug('Order status', { orderId, orderStatus, matched });
    }

    // If order didn't fully fill, cancel the remainder to avoid orphaned risk
    if (totalFilled < tokenAmount * 0.99 && totalFilled < tokenAmount) {
      await this.cancelOrder(orderId);
    }

    const avgPrice = totalFilled > 0 ? totalProceeds / totalFilled : 0;
    return { filled: totalFilled, avgPrice, proceeds: totalProceeds };
  }

  private async cancelOrder(orderId: string): Promise<void> {
    try {
      await axios.delete(`${CONFIG.CLOB_API_URL}/order/${orderId}`, {
        headers: this.clobAuthHeaders(),
        timeout: 8_000,
      });
      logger.info('CLOB order cancelled', { orderId });
    } catch (err) {
      logger.warn('Failed to cancel CLOB order', { orderId, error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // EIP-712 order signing for Polymarket CTF Exchange
  // -------------------------------------------------------------------------

  private async signClobOrder(order: Omit<ClobOrder, 'signature'>): Promise<string> {
    // Polymarket CTF Exchange EIP-712 domain (Polygon mainnet chainId = 137)
    const domain: ethers.TypedDataDomain = {
      name:              'CTF Exchange',
      version:           '1',
      chainId:           137,
      verifyingContract: CONFIG.CTF_EXCHANGE,
    };

    const types = {
      Order: [
        { name: 'salt',          type: 'uint256' },
        { name: 'maker',         type: 'address' },
        { name: 'signer',        type: 'address' },
        { name: 'taker',         type: 'address' },
        { name: 'tokenId',       type: 'uint256' },
        { name: 'makerAmount',   type: 'uint256' },
        { name: 'takerAmount',   type: 'uint256' },
        { name: 'expiration',    type: 'uint256' },
        { name: 'nonce',         type: 'uint256' },
        { name: 'feeRateBps',    type: 'uint256' },
        { name: 'side',          type: 'uint8'   },
        { name: 'signatureType', type: 'uint8'   },
      ],
    };

    const value = {
      salt:          BigInt(order.salt),
      maker:         order.maker,
      signer:        order.signer,
      taker:         order.taker,
      tokenId:       BigInt(order.tokenId),
      makerAmount:   BigInt(order.makerAmount),
      takerAmount:   BigInt(order.takerAmount),
      expiration:    BigInt(order.expiration),
      nonce:         BigInt(order.nonce),
      feeRateBps:    BigInt(order.feeRateBps),
      side:          parseInt(order.side, 10),
      signatureType: parseInt(order.signatureType, 10),
    };

    return this.wallet.signTypedData(domain, types, value);
  }

  // -------------------------------------------------------------------------
  // CLOB REST authentication headers (HMAC)
  // -------------------------------------------------------------------------

  private clobAuthHeaders(): Record<string, string> {
    // Polymarket CLOB uses L1 wallet signature for auth, not traditional HMAC.
    // The API key / secret / passphrase are returned during the key-derivation
    // flow and passed as headers per https://docs.polymarket.com/#authentication
    return {
      'POLY_ADDRESS':    this.wallet.address,
      'POLY_API_KEY':    CONFIG.POLYMARKET_API_KEY,
      'POLY_PASSPHRASE': CONFIG.POLYMARKET_API_PASSPHRASE,
      'POLY_SIGNATURE':  this.buildRequestSignature(),
      'Content-Type':    'application/json',
    };
  }

  /**
   * Build the request-level HMAC-SHA256 signature for Polymarket CLOB auth.
   * The signature covers: timestamp + method + requestPath + (body if POST).
   *
   * We use a simplified scheme consistent with Polymarket's Python client:
   *   message = timestamp + "POST" + "/order"
   *   signature = HMAC-SHA256(secret, message), base64url-encoded
   */
  private buildRequestSignature(): string {
    const crypto = require('crypto') as typeof import('crypto');
    const ts      = Math.floor(Date.now() / 1_000).toString();
    const message = ts + 'POST' + '/order';
    const sig     = crypto
      .createHmac('sha256', CONFIG.POLYMARKET_API_SECRET)
      .update(message)
      .digest('base64url');
    return sig;
  }

  // -------------------------------------------------------------------------
  // Balance check utilities (called from main.ts)
  // -------------------------------------------------------------------------

  async usdcBalance(): Promise<number> {
    const raw: bigint = await this.usdc.balanceOf(this.wallet.address);
    return Number(raw) / 10 ** USDC_DECIMALS;
  }

  async maticBalance(): Promise<number> {
    const raw = await this.provider.getBalance(this.wallet.address);
    return Number(ethers.formatEther(raw));
  }
}
