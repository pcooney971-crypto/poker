/**
 * scripts/derive-apikeys.ts
 * =========================
 * Derives (or creates) your Polymarket CLOB API credentials from your
 * L1 (Polygon) wallet. These are the POLYMARKET_API_KEY, API_SECRET, and
 * API_PASSPHRASE values required in .env.
 *
 * Background:
 *   Polymarket uses a two-layer auth model:
 *   - L1 = your Polygon wallet (signs on-chain transactions + initial API auth)
 *   - L2 = an API keypair derived from the L1 key (used for REST/WS requests)
 *
 * The L2 key is deterministically derived by signing a standard message with
 * your L1 private key. This script does exactly that and either retrieves
 * existing keys or creates new ones.
 *
 * Usage:
 *   npx ts-node scripts/derive-apikeys.ts
 *
 * Then copy the printed KEY / SECRET / PASSPHRASE into your .env.
 *
 * Reference:
 *   https://docs.polymarket.com/#authentication
 *   https://github.com/Polymarket/py-clob-client (Python reference impl)
 */

import { ethers }  from 'ethers';
import axios        from 'axios';
import * as crypto  from 'crypto';
import * as dotenv  from 'dotenv';

dotenv.config();

const CLOB_URL = process.env['CLOB_API_URL'] ?? 'https://clob.polymarket.com';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// ---------------------------------------------------------------------------
// Polymarket API key derivation (mirrors the official Python client)
// ---------------------------------------------------------------------------

/**
 * Build the HMAC-SHA256 request signature Polymarket expects on every call.
 *
 * message = timestamp_seconds + method + requestPath
 * signature = HMAC-SHA256(api_secret, message) in base64url
 */
function buildSignature(secret: string, method: string, path: string): string {
  const ts      = Math.floor(Date.now() / 1_000).toString();
  const message = ts + method + path;
  const sig     = crypto.createHmac('sha256', secret).update(message).digest('base64url');
  return sig;
}

function authHeaders(key: string, secret: string, passphrase: string, method: string, path: string) {
  return {
    'POLY_ADDRESS':    '',     // filled in below
    'POLY_API_KEY':    key,
    'POLY_PASSPHRASE': passphrase,
    'POLY_SIGNATURE':  buildSignature(secret, method, path),
    'Content-Type':    'application/json',
  };
}

// ---------------------------------------------------------------------------
// L1 wallet signature (used to authenticate key creation)
// ---------------------------------------------------------------------------

async function buildL1AuthHeader(wallet: ethers.Wallet, timestamp: number): Promise<string> {
  // Polymarket key derivation message (from their documentation)
  const message  = `Welcome to Polymarket!\n\nTimestamp: ${timestamp}`;
  const sig      = await wallet.signMessage(message);
  return sig;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  POLYMARKET API KEY DERIVATION');
  console.log('═'.repeat(60));

  const privateKey = requireEnv('PRIVATE_KEY');
  const rpcUrl     = requireEnv('POLYGON_HTTPS_URL');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(privateKey, provider);

  console.log(`\nWallet address: ${wallet.address}`);

  // ── Step 1: Check if API keys already exist for this address ────────────
  console.log('\n► Checking for existing API keys…');

  const timestamp = Math.floor(Date.now() / 1_000);
  const l1Sig     = await buildL1AuthHeader(wallet, timestamp);

  // The /auth/api-key endpoint lists existing keys for the address
  let existingKeys: Array<{ key: string; secret: string; passphrase: string }> = [];

  try {
    const resp = await axios.get<{ apiKeys: typeof existingKeys }>(
      `${CLOB_URL}/auth/api-key`,
      {
        headers: {
          'POLY_ADDRESS':   wallet.address,
          'POLY_SIGNATURE': l1Sig,
          'POLY_TIMESTAMP': timestamp.toString(),
          'Content-Type':   'application/json',
        },
        timeout: 10_000,
      },
    );
    existingKeys = resp.data?.apiKeys ?? [];
  } catch (err) {
    // 404 means no keys yet — that's fine
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status !== 404) {
      console.warn(`  Warning: could not check existing keys (${String(err)})`);
    }
  }

  // ── Step 2: Use existing key or create a new one ────────────────────────
  let apiKey:        string;
  let apiSecret:     string;
  let apiPassphrase: string;

  if (existingKeys.length > 0) {
    // Prefer to reuse the first existing key
    const k     = existingKeys[0]!;
    apiKey       = k.key;
    apiSecret    = k.secret;
    apiPassphrase= k.passphrase;

    console.log(`  ✓  Found ${existingKeys.length} existing key(s). Using first key.`);
  } else {
    // Create a new API key by signing the derivation message
    console.log('  No existing keys found — creating new API key…');

    const ts2   = Math.floor(Date.now() / 1_000);
    const sig2  = await buildL1AuthHeader(wallet, ts2);

    try {
      const resp = await axios.post<{ apiKey: string; secret: string; passphrase: string }>(
        `${CLOB_URL}/auth/api-key`,
        {},
        {
          headers: {
            'POLY_ADDRESS':   wallet.address,
            'POLY_SIGNATURE': sig2,
            'POLY_TIMESTAMP': ts2.toString(),
            'Content-Type':   'application/json',
          },
          timeout: 10_000,
        },
      );

      apiKey        = resp.data.apiKey;
      apiSecret     = resp.data.secret;
      apiPassphrase = resp.data.passphrase;

      console.log('  ✓  New API key created successfully');
    } catch (err) {
      console.error('\nFailed to create API key:', String(err));
      console.error('\nIf you see a 403 error, your wallet may need to be allowlisted.');
      console.error('Visit https://polymarket.com, connect your wallet, and accept the terms.');
      process.exit(1);
    }
  }

  // ── Step 3: Verify the key works ────────────────────────────────────────
  console.log('\n► Verifying API key against CLOB…');

  try {
    const headers = authHeaders(apiKey, apiSecret, apiPassphrase, 'GET', '/balance-allowance');
    headers['POLY_ADDRESS'] = wallet.address;

    await axios.get(`${CLOB_URL}/balance-allowance?asset_type=USDC`, {
      headers,
      timeout: 10_000,
    });
    console.log('  ✓  API key verified successfully');
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 403) {
      console.error('  ✗  403 Forbidden — API key is invalid or expired');
    } else {
      console.warn(`  ⚠  Could not verify key (${String(err)}) — key may still be valid`);
    }
  }

  // ── Step 4: Print .env lines ─────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  Copy these lines into your .env file:');
  console.log('═'.repeat(60));
  console.log(`\nPOLYMARKET_API_KEY=${apiKey}`);
  console.log(`POLYMARKET_API_SECRET=${apiSecret}`);
  console.log(`POLYMARKET_API_PASSPHRASE=${apiPassphrase}`);
  console.log('\n' + '═'.repeat(60));
  console.log('  IMPORTANT: treat API_SECRET like a password — never commit it.');
  console.log('═'.repeat(60) + '\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
