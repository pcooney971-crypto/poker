/**
 * config.ts
 * Centralised configuration loader. All env vars are validated at startup
 * so missing secrets fail fast rather than silently at trade time.
 */

import * as dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optionalEnv(name: string, defaultVal: string): string {
  return process.env[name] ?? defaultVal;
}

function requirePositiveNumber(name: string): number {
  const raw = requireEnv(name);
  const n = parseFloat(raw);
  if (isNaN(n) || n <= 0) throw new Error(`Env var ${name} must be a positive number, got: ${raw}`);
  return n;
}

// ---------------------------------------------------------------------------
// Exported config object (singleton, read-only at runtime)
// ---------------------------------------------------------------------------
export const CONFIG = Object.freeze({
  // ---- Wallet ----
  PRIVATE_KEY: requireEnv('PRIVATE_KEY'),

  // ---- Polymarket credentials ----
  POLYMARKET_API_KEY:        requireEnv('POLYMARKET_API_KEY'),
  POLYMARKET_API_SECRET:     requireEnv('POLYMARKET_API_SECRET'),
  POLYMARKET_API_PASSPHRASE: requireEnv('POLYMARKET_API_PASSPHRASE'),

  // ---- RPC ----
  POLYGON_WSS_URL:      requireEnv('POLYGON_WSS_URL'),
  POLYGON_HTTPS_URL:    requireEnv('POLYGON_HTTPS_URL'),
  POLYGON_WSS_FALLBACK: optionalEnv('POLYGON_WSS_FALLBACK', ''),

  // ---- Weather ----
  CHECKWX_API_KEY:          requireEnv('CHECKWX_API_KEY'),
  METAR_STATIONS:           requireEnv('METAR_STATIONS').split(',').map(s => s.trim()),
  METAR_POLL_INTERVAL_MS:   parseInt(optionalEnv('METAR_POLL_INTERVAL_MS', '15000'), 10),
  TEMPERATURE_UNIT:         optionalEnv('TEMPERATURE_UNIT', 'F') as 'F' | 'C',

  // ---- Market ----
  CONDITION_ID:     requireEnv('CONDITION_ID'),
  YES_TOKEN_ID:     requireEnv('YES_TOKEN_ID'),
  NO_TOKEN_ID:      requireEnv('NO_TOKEN_ID'),
  TEMP_THRESHOLD:   requirePositiveNumber('TEMP_THRESHOLD'),

  // ---- Trading parameters ----
  MAX_POSITION_USDC:      requirePositiveNumber('MAX_POSITION_USDC'),
  MIN_EV_EDGE:            requirePositiveNumber('MIN_EV_EDGE'),
  MAX_SLIPPAGE_FRACTION:  requirePositiveNumber('MAX_SLIPPAGE_FRACTION'),
  ORDER_BOOK_DEPTH:       parseInt(optionalEnv('ORDER_BOOK_DEPTH', '10'), 10),
  GAS_LIMIT_SPLIT:        BigInt(optionalEnv('GAS_LIMIT_SPLIT', '250000')),
  GAS_LIMIT_ORDER:        BigInt(optionalEnv('GAS_LIMIT_ORDER', '200000')),

  // ---- Gas strategy ----
  BASE_FEE_MULTIPLIER: parseFloat(optionalEnv('BASE_FEE_MULTIPLIER', '1.5')),
  PRIORITY_FEE_GWEI:   parseFloat(optionalEnv('PRIORITY_FEE_GWEI', '50')),

  // ---- Contracts ----
  CTF_CONTRACT:       optionalEnv('CTF_CONTRACT',       '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'),
  CTF_EXCHANGE:       optionalEnv('CTF_EXCHANGE',       '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'),
  NEG_RISK_EXCHANGE:  optionalEnv('NEG_RISK_EXCHANGE',  '0xC5d563A36AE78145C45a50134d48A1215220f80a'),
  USDC_CONTRACT:      optionalEnv('USDC_CONTRACT',      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'),

  // ---- API endpoints ----
  GAMMA_API_URL: optionalEnv('GAMMA_API_URL', 'https://gamma-api.polymarket.com'),
  CLOB_API_URL:  optionalEnv('CLOB_API_URL',  'https://clob.polymarket.com'),
  CLOB_WS_URL:   optionalEnv('CLOB_WS_URL',   'wss://clob.polymarket.com/ws'),

  // ---- Logging ----
  LOG_LEVEL: optionalEnv('LOG_LEVEL', 'info'),
  LOG_DIR:   optionalEnv('LOG_DIR',   './logs'),
} as const);

// ---- Derived convenience values ----
export const USDC_DECIMALS = 6;
export const GWEI = 1_000_000_000n; // 1e9
