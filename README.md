# Polymarket HFT Weather Arbitrage Bot

A high-frequency arbitrage bot that exploits latency between live aviation weather (METAR) data updates and Polymarket's temperature prediction markets. Written in TypeScript, targeting Polygon mainnet.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         main.ts (orchestrator)                  │
│                                                                 │
│   ┌──────────────┐   threshold_met   ┌─────────────────────┐   │
│   │ data_feed.ts │ ───────────────►  │  ev_calculator.ts   │   │
│   │ (METAR WS)   │                   │  (EV + slippage)    │   │
│   └──────────────┘                   └──────────┬──────────┘   │
│                                                 │ shouldTrade  │
│   ┌──────────────┐   book snapshot              ▼              │
│   │ orderbook.ts │ ────────────────►  ┌─────────────────────┐  │
│   │ (CLOB WS)    │                    │   execution.ts      │  │
│   └──────────────┘                    │   A. Approve USDC   │  │
│                                       │   B. CTF Split      │  │
│   ┌──────────────┐   gas prices       │   C. CLOB Sell NO   │  │
│   │   gas.ts     │ ───────────────►   │   D. Monitor Fill   │  │
│   │ (EIP-1559)   │                    └─────────────────────┘  │
│   └──────────────┘                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Module Summary

| File | Responsibility |
|---|---|
| `src/config.ts` | Env validation, typed config singleton |
| `src/logger.ts` | Winston structured logger + daily rotation |
| `src/gas.ts` | EIP-1559 gas pricing, tx waiting, retry logic |
| `src/data_feed.ts` | METAR WebSocket feed, raw-string parser, REST fallback |
| `src/orderbook.ts` | Polymarket CLOB WebSocket monitor, book snapshot |
| `src/ev_calculator.ts` | EV formula, slippage protection, VWAP calculation |
| `src/execution.ts` | USDC approve → CTF split → CLOB sign & submit |
| `src/main.ts` | Orchestrator, cooldown guard, heartbeat, graceful shutdown |

---

## Prerequisites

| Requirement | Details |
|---|---|
| Node.js ≥ 20 | LTS recommended |
| Polygon mainnet wallet | Must hold USDC.e + MATIC |
| Alchemy (or QuickNode) API key | WebSocket endpoint required |
| CheckWX API key | Aviation weather (METAR) feed |
| Polymarket account | L1 wallet linked, API keys generated |

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url> polymarket-hft-bot
cd polymarket-hft-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env       # fill in all required values
```

Critical variables:
- `PRIVATE_KEY` — the trading wallet private key (keep this secret)
- `POLYGON_WSS_URL` — Alchemy/QuickNode WebSocket URL
- `CHECKWX_API_KEY` — aviation weather API key
- `POLYMARKET_API_KEY/SECRET/PASSPHRASE` — from your Polymarket account
- `CONDITION_ID` — the specific market's condition ID (from Gamma API or market URL)
- `YES_TOKEN_ID` / `NO_TOKEN_ID` — ERC-1155 token IDs for the market outcomes
- `TEMP_THRESHOLD` — the temperature the market resolves on

### 3. Find market details

Use the Gamma API to discover markets:

```bash
# List active weather markets
curl "https://gamma-api.polymarket.com/markets?active=true&tag=weather" | jq '.[] | {slug, conditionId, question}'

# Get token IDs for a specific market
curl "https://gamma-api.polymarket.com/markets?conditionId=0xYOUR_CONDITION_ID" | jq '.tokens'
```

### 4. Build and start

```bash
# Production build
npm run build
npm start

# Development (ts-node, hot output)
npm run dev
```

---

## Deployment on AWS (Colocated — US-East-1)

Polymarket's infrastructure runs on AWS US-East.  Colocating in `us-east-1`
minimises the round-trip latency between your bot and both the CLOB API and
the Polygon RPC endpoint.

### EC2 setup (t3.medium or better)

```bash
# Ubuntu 22.04 LTS
sudo apt update && sudo apt install -y git curl build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Clone bot
git clone <repo-url> /opt/polymarket-bot
cd /opt/polymarket-bot
npm install
npm run build

# Copy and fill env
cp .env.example .env
nano .env
```

### Run with PM2 (process manager)

```bash
npm install -g pm2

# Start bot
pm2 start dist/main.js --name polymarket-bot --max-memory-restart 512M

# Save process list for reboot persistence
pm2 save
pm2 startup   # follow the printed command to register systemd service

# Monitor
pm2 logs polymarket-bot --lines 100
pm2 monit
```

### Log management

Logs rotate daily and are stored in `./logs/`:

| File | Contents |
|---|---|
| `bot-YYYY-MM-DD.log` | All structured JSON events |
| `error-YYYY-MM-DD.log` | Errors only |
| `trades-YYYY-MM-DD.log` | Trade records (kept 365 days) |

Stream live logs:
```bash
tail -f logs/bot-$(date +%Y-%m-%d).log | jq .
```

---

## EV & Slippage Logic

### The "Split and Sell NO" strategy

1. **Split**: Deposit `X` USDC.e → CTF contract mints `X` YES + `X` NO tokens
2. **Sell NO**: Place a limit maker order selling NO tokens on the CLOB
3. **Hold YES**: Retain YES tokens at effective cost = `X − NO_sale_proceeds`

### Expected value formula

```
true_prob_YES  = 0.99   (threshold definitively met by fresh METAR reading)
sell_price_NO  = VWAP across bid tiers consumed by the order

EV per USDC deployed = true_prob_YES + sell_price_NO − 1
                     = 0.99 + sell_price_NO − 1
                     = sell_price_NO − 0.01

Minimum viable sell_price_NO for MIN_EV_EDGE = 0.03:
  sell_price_NO ≥ 0.01 + 0.03 = 0.04  (4¢ for NO)
```

In practice, if the temperature threshold has been definitively met and the
market hasn't repriced yet, NO tokens will still be trading at 5–15¢.
This is the arbitrage window.

### Slippage protection

- We walk the bid ladder and compute VWAP for our entire position before committing.
- If our order would consume > `MAX_SLIPPAGE_FRACTION` (default 20%) of available liquidity, we size down.
- We never place market orders — only limit maker orders.

---

## Smart Contract Addresses (Polygon Mainnet)

| Contract | Address |
|---|---|
| Conditional Tokens Framework (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| CTF Exchange (CLOB settlement) | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg Risk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| USDC.e (bridged) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

---

## Gas Strategy

The bot uses EIP-1559 with an aggressive tip to ensure next-block inclusion:

```
maxFeePerGas         = baseFee × BASE_FEE_MULTIPLIER + priorityFee
maxPriorityFeePerGas = PRIORITY_FEE_GWEI × 1e9
```

Polygon base fees are typically 30–300 GWEI.  Setting `PRIORITY_FEE_GWEI=50`
means you'll outbid most competitors while the unused fee is refunded.

---

## WebSocket Reconnection

Both the weather feed and CLOB monitor implement exponential backoff:

| Attempt | Delay |
|---|---|
| 1st reconnect | 2 s |
| 2nd reconnect | 4 s |
| 3rd reconnect | 8 s |
| 4th+ | 16 s → capped at 60 s |

During any WS outage, the weather feed falls back to REST polling on
`METAR_POLL_INTERVAL_MS` (default 15 s), and the order book is refreshed
via REST snapshot.

---

## Security Checklist

- [ ] `.env` file is in `.gitignore` — never commit secrets
- [ ] Wallet holds only the working capital needed; withdraw profits regularly
- [ ] RPC URL contains your personal API key — rotate if compromised
- [ ] Bot wallet is separate from your main wallet
- [ ] `MAX_POSITION_USDC` is set conservatively until you have verified behaviour on mainnet
- [ ] Start with `MIN_EV_EDGE=0.10` (10%) and reduce only after confirming execution quality

---

## Troubleshooting

**`Missing required environment variable: X`**
→ Check `.env` file is present and all required keys are filled.

**`Wrong network: expected Polygon (137), got …`**
→ Your RPC URL is pointing at a different chain. Check `POLYGON_WSS_URL`.

**`No NO bids above minimum price`**
→ The market has already repriced. The arbitrage window has closed.

**`Tx reverted on-chain`**
→ Check USDC.e balance and allowance. Also check `GAS_LIMIT_SPLIT` is adequate.

**`CLOB order placement failed (403)`**
→ Regenerate Polymarket API credentials — they may have expired.

**Low fill rate on NO orders**
→ Reduce `ORDER_TTL_SECONDS` in `execution.ts` or lower the limit price slightly.

---

## Disclaimer

This software is provided for educational and research purposes. Trading prediction markets involves substantial financial risk. Always test with small amounts and understand the mechanisms fully before deploying real capital. The authors assume no responsibility for trading losses.
