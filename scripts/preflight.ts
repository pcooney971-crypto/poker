/**
 * scripts/preflight.ts
 * ====================
 * One-time on-chain initialisation script. Run this ONCE before starting
 * the bot for the first time (and again whenever you change markets).
 *
 * What it does (all automatic):
 * ─────────────────────────────
 *  1. Validates all env vars are present and parseable.
 *  2. Connects to Polygon and confirms the correct chain.
 *  3. Checks MATIC balance — warns if < 2 MATIC.
 *  4. Checks USDC.e balance — errors if < MIN needed for first trade.
 *  5. Grants USDC.e max-allowance to the CTF contract (avoids a separate
 *     approve tx on every trade cycle).
 *  6. Calls CTF.setApprovalForAll(CTF_EXCHANGE, true) so the exchange
 *     contract can move your conditional tokens when filling orders.
 *     Without this, every sell order will revert on-chain.
 *  7. Verifies the target market exists and is still active via Gamma API.
 *  8. Fetches and prints the YES/NO token IDs (so you can confirm they
 *     match what is in your .env file).
 *  9. Checks the current CLOB mid-price for both tokens.
 * 10. Writes a preflight-complete marker file (.preflight_ok) that
 *     setup-server.sh looks for before starting the bot service.
 *
 * Usage:
 *   npx ts-node scripts/preflight.ts
 *
 * Safe to re-run: all on-chain calls are idempotent (approve uses
 * MaxUint256, setApprovalForAll is a no-op if already set).
 */

import { ethers } from 'ethers';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// ── Minimal ABIs ────────────────────────────────────────────────────────────

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

const CTF_ABI = [
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function ok(msg: string)   { console.log(`  ✓  ${msg}`); }
function warn(msg: string) { console.log(`  ⚠  ${msg}`); }
function fail(msg: string) { console.log(`  ✗  ${msg}`); process.exit(1); }
function step(msg: string) { console.log(`\n► ${msg}`); }

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  POLYMARKET BOT — PREFLIGHT INITIALISATION');
  console.log('═'.repeat(60));

  // ── 1. Env validation ──────────────────────────────────────────────────
  step('Validating environment variables');

  const REQUIRED = [
    'PRIVATE_KEY', 'POLYGON_WSS_URL', 'POLYGON_HTTPS_URL',
    'CHECKWX_API_KEY', 'METAR_STATIONS',
    'CONDITION_ID', 'YES_TOKEN_ID', 'NO_TOKEN_ID',
    'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE',
    'TEMP_THRESHOLD',
  ];

  let missingAny = false;
  for (const key of REQUIRED) {
    if (!process.env[key]) {
      warn(`Missing: ${key}`);
      missingAny = true;
    }
  }
  if (missingAny) fail('Fix missing env vars before continuing.');
  ok('All required env vars present');

  // ── 2. Connect RPC ─────────────────────────────────────────────────────
  step('Connecting to Polygon RPC');

  const provider = new ethers.JsonRpcProvider(env('POLYGON_HTTPS_URL'));
  const network  = await provider.getNetwork().catch(() => null);

  if (!network) fail('Could not connect to RPC — check POLYGON_HTTPS_URL');
  if (Number(network!.chainId) !== 137) {
    fail(`Wrong chain: expected 137 (Polygon), got ${network!.chainId}`);
  }
  ok(`Connected — chain ${network!.chainId} (${network!.name})`);

  // Block number sanity check
  const block = await provider.getBlockNumber();
  ok(`Latest block: ${block}`);

  // ── 3. Wallet ──────────────────────────────────────────────────────────
  step('Loading wallet');

  const wallet = new ethers.Wallet(env('PRIVATE_KEY'), provider);
  ok(`Address: ${wallet.address}`);

  // ── 4. MATIC balance ───────────────────────────────────────────────────
  step('Checking MATIC balance (gas)');

  const maticWei  = await provider.getBalance(wallet.address);
  const maticBal  = parseFloat(ethers.formatEther(maticWei));
  if (maticBal < 0.5) {
    fail(`MATIC balance too low: ${maticBal.toFixed(4)} MATIC. Need ≥ 0.5 MATIC.`);
  } else if (maticBal < 2) {
    warn(`Low MATIC balance: ${maticBal.toFixed(4)}. Consider topping up.`);
  } else {
    ok(`MATIC balance: ${maticBal.toFixed(4)} MATIC`);
  }

  // ── 5. USDC.e balance ─────────────────────────────────────────────────
  step('Checking USDC.e balance');

  const CTF_CONTRACT   = process.env['CTF_CONTRACT']  ?? '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const CTF_EXCHANGE   = process.env['CTF_EXCHANGE']  ?? '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
  const USDC_CONTRACT  = process.env['USDC_CONTRACT'] ?? '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

  const usdc     = new ethers.Contract(USDC_CONTRACT, USDC_ABI, wallet);
  const ctf      = new ethers.Contract(CTF_CONTRACT,  CTF_ABI,  wallet);

  const decimals: number = await usdc.decimals();
  const usdcRaw: bigint  = await usdc.balanceOf(wallet.address);
  const usdcBal          = Number(usdcRaw) / 10 ** decimals;
  const maxPos           = parseFloat(process.env['MAX_POSITION_USDC'] ?? '500');

  if (usdcBal < 1) {
    fail(`USDC.e balance too low: $${usdcBal.toFixed(2)}. Fund wallet before running bot.`);
  } else if (usdcBal < maxPos) {
    warn(`USDC.e balance $${usdcBal.toFixed(2)} < MAX_POSITION_USDC $${maxPos}. Bot will size down.`);
  } else {
    ok(`USDC.e balance: $${usdcBal.toFixed(2)}`);
  }

  // ── 6. Approve USDC.e → CTF (max allowance) ───────────────────────────
  step('Setting USDC.e allowance for CTF contract');

  const currentAllowance: bigint = await usdc.allowance(wallet.address, CTF_CONTRACT);
  const MAX_UINT256 = ethers.MaxUint256;

  if (currentAllowance >= MAX_UINT256 / 2n) {
    ok('Max allowance already set — skipping approve tx');
  } else {
    console.log('  Sending USDC approve(CTF, MaxUint256)…');
    const tx: ethers.TransactionResponse = await (usdc as ethers.Contract).approve(CTF_CONTRACT, MAX_UINT256);
    console.log(`  Tx hash: ${tx.hash}`);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status === 0) fail('USDC approve tx reverted');
    ok(`USDC.e approved for CTF contract (block ${receipt!.blockNumber})`);
  }

  // ── 7. setApprovalForAll: CTF → CTF Exchange ───────────────────────────
  step('Setting CTF token approval for CTF Exchange');

  const isApproved: boolean = await ctf.isApprovedForAll(wallet.address, CTF_EXCHANGE);

  if (isApproved) {
    ok('CTF Exchange already approved for all tokens — skipping');
  } else {
    console.log('  Sending CTF.setApprovalForAll(CTF_EXCHANGE, true)…');
    const tx: ethers.TransactionResponse = await (ctf as ethers.Contract).setApprovalForAll(CTF_EXCHANGE, true, {
      gasLimit: 100_000,
    });
    console.log(`  Tx hash: ${tx.hash}`);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status === 0) fail('setApprovalForAll tx reverted');
    ok(`CTF Exchange approved for conditional tokens (block ${receipt!.blockNumber})`);
  }

  // ── 8. Verify market via Gamma API ────────────────────────────────────
  step('Verifying target market on Gamma API');

  const GAMMA_URL  = process.env['GAMMA_API_URL'] ?? 'https://gamma-api.polymarket.com';
  const CONDITION  = env('CONDITION_ID');

  interface GammaMarket {
    active:      boolean;
    closed:      boolean;
    question:    string;
    endDate:     string;
    tokens:      Array<{ token_id: string; outcome: string }>;
  }

  let market: GammaMarket | null = null;
  try {
    const resp = await axios.get<GammaMarket[]>(
      `${GAMMA_URL}/markets?conditionId=${CONDITION}`,
      { timeout: 10_000 },
    );
    market = resp.data?.[0] ?? null;
  } catch (err) {
    warn(`Gamma API unreachable: ${String(err)}`);
  }

  if (!market) {
    warn('Could not fetch market from Gamma API — check CONDITION_ID');
  } else {
    if (!market.active || market.closed) {
      fail(`Market is not active! active=${market.active} closed=${market.closed}`);
    }
    ok(`Market: "${market.question}"`);
    ok(`End date: ${market.endDate}`);

    // Print token IDs so user can confirm they match .env
    for (const tok of market.tokens) {
      const envKey   = tok.outcome.toUpperCase() === 'YES' ? 'YES_TOKEN_ID' : 'NO_TOKEN_ID';
      const envVal   = process.env[envKey] ?? '';
      const matches  = envVal === tok.token_id ? '✓ matches .env' : `✗ MISMATCH — .env has ${envVal.slice(0,12)}…`;
      ok(`  ${tok.outcome} token: ${tok.token_id.slice(0, 20)}… [${matches}]`);
    }
  }

  // ── 9. CLOB mid-price check ────────────────────────────────────────────
  step('Checking CLOB prices for YES / NO tokens');

  const CLOB_URL = process.env['CLOB_API_URL'] ?? 'https://clob.polymarket.com';

  for (const [label, tokenId] of [['YES', env('YES_TOKEN_ID')], ['NO', env('NO_TOKEN_ID')]]) {
    try {
      const resp = await axios.get<{ mid_price: string }>(
        `${CLOB_URL}/midpoint?token_id=${tokenId}`,
        { timeout: 8_000 },
      );
      const mid = parseFloat(resp.data.mid_price ?? '0');
      ok(`${label} mid-price: ${(mid * 100).toFixed(1)}¢ (${mid.toFixed(4)})`);
    } catch {
      warn(`Could not fetch ${label} mid-price from CLOB`);
    }
  }

  // ── 10. Write preflight marker ─────────────────────────────────────────
  step('Writing preflight completion marker');

  const markerPath = path.join(process.cwd(), '.preflight_ok');
  fs.writeFileSync(markerPath, JSON.stringify({
    completedAt:  new Date().toISOString(),
    walletAddress: wallet.address,
    conditionId:  CONDITION,
    chainId:      Number(network!.chainId),
  }, null, 2));

  ok(`.preflight_ok written at ${markerPath}`);

  // ── Done ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  PREFLIGHT COMPLETE — bot is ready to start');
  console.log('  Run: npm start   (or: pm2 start dist/main.js)');
  console.log('═'.repeat(60) + '\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
