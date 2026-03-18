/**
 * scripts/fetch-market.ts
 * =======================
 * CLI tool to discover Polymarket weather markets and extract the exact
 * values you need to paste into your .env file.
 *
 * Usage:
 *   # List all active weather markets
 *   npx ts-node scripts/fetch-market.ts
 *
 *   # Search by keyword
 *   npx ts-node scripts/fetch-market.ts "New York temperature"
 *
 *   # Show full detail for a specific condition ID
 *   npx ts-node scripts/fetch-market.ts --condition 0xabc123…
 *
 * Output includes ready-to-paste .env lines.
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GAMMA_URL = process.env['GAMMA_API_URL'] ?? 'https://gamma-api.polymarket.com';
const CLOB_URL  = process.env['CLOB_API_URL']  ?? 'https://clob.polymarket.com';

interface GammaToken {
  token_id: string;
  outcome:  string;
  price:    number;
}

interface GammaMarket {
  id:            string;
  question:      string;
  conditionId:   string;
  active:        boolean;
  closed:        boolean;
  endDate:       string;
  volume:        number;
  liquidity:     number;
  tokens:        GammaToken[];
  tags:          string[];
}

async function fetchMarkets(keyword?: string): Promise<GammaMarket[]> {
  const params: Record<string, string | boolean> = {
    active:   true,
    closed:   false,
    limit:    '50',
    tag:      'weather',
  };

  const resp = await axios.get<GammaMarket[]>(`${GAMMA_URL}/markets`, {
    params,
    timeout: 15_000,
  });

  let markets = resp.data ?? [];

  if (keyword) {
    const kw = keyword.toLowerCase();
    markets = markets.filter(m => m.question.toLowerCase().includes(kw));
  }

  return markets;
}

async function fetchMarketByCondition(conditionId: string): Promise<GammaMarket | null> {
  const resp = await axios.get<GammaMarket[]>(
    `${GAMMA_URL}/markets?conditionId=${conditionId}`,
    { timeout: 10_000 },
  );
  return resp.data?.[0] ?? null;
}

async function fetchClobOrderBook(tokenId: string): Promise<{ bids: number; asks: number; midPrice: number }> {
  try {
    const [bookResp, midResp] = await Promise.all([
      axios.get<{ bids: Array<{price: string; size: string}>; asks: Array<{price: string; size: string}> }>(
        `${CLOB_URL}/book?token_id=${tokenId}`,
        { timeout: 8_000 },
      ),
      axios.get<{ mid_price: string }>(
        `${CLOB_URL}/midpoint?token_id=${tokenId}`,
        { timeout: 8_000 },
      ),
    ]);

    const bidLiq = (bookResp.data.bids ?? [])
      .reduce((s, b) => s + parseFloat(b.price) * parseFloat(b.size), 0);
    const askLiq = (bookResp.data.asks ?? [])
      .reduce((s, a) => s + parseFloat(a.price) * parseFloat(a.size), 0);

    return {
      bids:     bidLiq,
      asks:     askLiq,
      midPrice: parseFloat(midResp.data.mid_price ?? '0'),
    };
  } catch {
    return { bids: 0, asks: 0, midPrice: 0 };
  }
}

function printMarket(m: GammaMarket, detailed = false) {
  const yes  = m.tokens.find(t => t.outcome.toUpperCase() === 'YES');
  const no   = m.tokens.find(t => t.outcome.toUpperCase() === 'NO');
  const vol  = m.volume   ? `$${(m.volume   / 1e6).toFixed(1)}M` : 'N/A';
  const liq  = m.liquidity ? `$${(m.liquidity / 1e3).toFixed(0)}K` : 'N/A';

  console.log('\n' + '─'.repeat(60));
  console.log(`Question : ${m.question}`);
  console.log(`End Date : ${m.endDate}`);
  console.log(`Volume   : ${vol}   Liquidity: ${liq}`);

  if (yes) console.log(`YES price: ${(yes.price * 100).toFixed(1)}¢`);
  if (no)  console.log(`NO  price: ${(no.price  * 100).toFixed(1)}¢`);

  if (detailed) {
    console.log('\n── Paste these into your .env ──────────────────────────');
    console.log(`CONDITION_ID=${m.conditionId}`);
    console.log(`YES_TOKEN_ID=${yes?.token_id ?? 'N/A'}`);
    console.log(`NO_TOKEN_ID=${no?.token_id  ?? 'N/A'}`);
    console.log('────────────────────────────────────────────────────────');
  } else {
    console.log(`Condition: ${m.conditionId}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  // --condition <id> mode
  const condIdx = args.indexOf('--condition');
  if (condIdx !== -1) {
    const conditionId = args[condIdx + 1];
    if (!conditionId) {
      console.error('Usage: --condition <conditionId>');
      process.exit(1);
    }

    console.log(`\nFetching market ${conditionId}…`);
    const market = await fetchMarketByCondition(conditionId);
    if (!market) {
      console.error('Market not found.');
      process.exit(1);
    }

    printMarket(market, true);

    // Fetch CLOB order book depth for each token
    console.log('\n── CLOB order book depths ──');
    for (const tok of market.tokens) {
      const book = await fetchClobOrderBook(tok.token_id);
      console.log(
        `${tok.outcome.padEnd(3)} | bid liq: $${book.bids.toFixed(0).padStart(6)} ` +
        `| ask liq: $${book.asks.toFixed(0).padStart(6)} ` +
        `| mid: ${(book.midPrice * 100).toFixed(1)}¢`,
      );
    }

    process.exit(0);
  }

  // List mode
  const keyword = args[0];
  console.log(`\nFetching active weather markets${keyword ? ` matching "${keyword}"` : ''}…`);

  const markets = await fetchMarkets(keyword);

  if (markets.length === 0) {
    console.log('No markets found. Try a different keyword or check the Gamma API.');
    process.exit(0);
  }

  // Sort by liquidity descending
  markets.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));

  console.log(`\nFound ${markets.length} market(s):\n`);
  for (const m of markets.slice(0, 20)) {
    printMarket(m, false);
  }

  console.log('\n── For full token IDs, run: ─────────────────────────────');
  console.log('  npx ts-node scripts/fetch-market.ts --condition <conditionId>');
  console.log('────────────────────────────────────────────────────────\n');

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
