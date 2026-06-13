# ICT Trading Terminal

> **DISCLAIMER — EXPERIMENT ONLY**
> This is a personal research experiment. It is not financial advice, not a commercial product, and not production-ready software. Crypto trading carries significant risk of total loss. The authors accept no responsibility for financial outcomes. **Use at your own risk. Never risk money you cannot afford to lose.**

---

A terminal-based (TUI) crypto trading tool that implements **ICT (Inner Circle Trader)** concepts for Binance Futures. Detects institutional setups across multiple timeframes, aggregates order book data from 7 exchanges, and optionally auto-executes trades.

```
╔══════════════════════════════════════════════════════════════════╗
║  BTCUSDT  $67,420  │  London KZ  │  HTF: Bullish  │  BOT LIVE  ║
╠══════════════════╤═══════════════╤═══════════════╤══════════════╣
║  Order Book      │  Sentiment    │  ICT Analysis │  Screener   ║
╚══════════════════╧═══════════════╧═══════════════╧══════════════╝
```

## Features

- **ICT Analysis** — Order Blocks, FVGs, Quasimodo, SR Flips, POI Stacks across 8 timeframes (1m → 1M)
- **Setup detection** — CB1 / CB2 / CR setups with confidence scoring (0–100), kill zone awareness, premium/discount bias
- **Multi-symbol screener** — Scans top-40 USDT perpetuals every 5 min, ranks by best ICT setup confidence, scrollable
- **Aggregated order book** — Live depth from Binance, Bybit, OKX, BingX, Bitget, Gate, Hyperliquid
- **Sentiment panel** — Fear & Greed index, funding rates, long/short ratios, news sentiment
- **Auto-trading bot** — Optional; executes market orders + SL/TP on Binance Futures when setups trigger
- **No database, no broker fees** — Pure terminal, runs anywhere Bun runs

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- Binance Futures account + API key (only required for bot mode)

## Installation

```bash
git clone https://github.com/your-username/trading.git
cd trading
bun install
```

## Usage

```bash
# Watch-only — order book, sentiment, ICT analysis, screener (no API key needed)
bun start --no-bot

# Auto-trading bot — prompts for Binance Futures API key/secret at startup
bun start

# Target a specific symbol (default: BTCUSDT)
bun start ETHUSDT
bun start --no-bot SOLUSDT
```

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Cycle views |
| `/` | Type a symbol to switch (e.g. `ETH` → auto-completes to `ETHUSDT`) |
| `+` / `-` | Increase/decrease order book depth (Book view) |
| `[` / `]` | Change tick size grouping (Book view) |
| `↑` / `↓` | Scroll setup list (Scan view) |
| `PgUp` / `PgDn` | Scroll 10 rows (Scan view) |
| `Home` | Jump to top of setup list (Scan view) |
| `q` / `Ctrl+C` | Quit |

### Views

| View | What you see |
|------|--------------|
| **Book** | Aggregated order book depth across all exchanges |
| **Sentiment** | Fear & Greed, funding rates, long/short ratios, crypto news |
| **ICT** | POIs, active setups, BOS/CHoCH events, premium/discount zone |
| **Scan** | Multi-symbol screener — top setups across the market, scrollable |
| **Bot** | Active trades, balance, P&L, error log |

## Bot Configuration

When running in bot mode, you'll be prompted at startup:

```
Bot configuration (press Enter to use defaults):
  Risk normal setup     [1%]:    ← % of balance risked per normal trade
  Risk high-conf (≥60%) [5%]:    ← % risked when confidence ≥ 60
  Max open trades        [3]:    ← hard cap on concurrent positions
  Min ICT confidence    [60]:    ← skip setups below this score
```

- Leverage is set to **maximum available** per symbol automatically
- Position size is calculated so a stop-out costs exactly `risk% × balance`, regardless of leverage
- Risk per trade is hard-capped at **10%** regardless of input
- API keys are kept in memory only — never written to disk
- On startup, the bot checks the last **2 hours of trade history** from Binance. Any symbol that had an open or recently closed position is skipped until the 2h window expires — no double-entry

> **Required API permissions**: Futures trading enabled. IP whitelisting is strongly recommended.

## ICT Concepts

This tool is built around [ICT methodology](https://www.youtube.com/@InnerCircleTrader). Here's a quick reference:

### Points of Interest (POI)

| Type | Description |
|------|-------------|
| **OB** (Order Block) | Last opposing candle before a displacement — institutional accumulation/distribution zone |
| **FVG** (Fair Value Gap) | Imbalance / gap between candle 1 high and candle 3 low (or inverse for bear) |
| **RBS / SBR** (SR Flip) | Resistance-Becomes-Support or Support-Becomes-Resistance after multiple tests |
| **QM** (Quasimodo) | Failed swing that traps breakout traders, signals a reversal |

### POI Stacks (Multi-TF Confluence)

POIs from different timeframe groups that overlap in price become a **stack**. The more timeframe groups aligned (macro: 1w/1d · intermediate: 4h/1h · entry: 15m/5m/1m), the higher the confidence. This is the core confluence filter.

### Setup Types

| Type | Trigger |
|------|---------|
| **CB1** | Price retraces into a POI stack after a confirmed BOS/CHoCH |
| **CB2** | Same as CB1 but enters from a fresh LTF valid POI inside the HTF zone (tighter entry) |
| **CR** | Continuation Reversal — POI stack at premium/discount extreme aligned with HTF trend |

### Kill Zones

Setups forming during high-liquidity sessions get a confidence bonus:

| Session | UTC Hours |
|---------|-----------|
| Asia | 00:00 – 04:00 |
| London | 07:00 – 10:00 |
| New York | 13:00 – 16:00 |

### Premium / Discount

Based on the HTF (1D) swing range:
- **Discount** (< 50%) → look for **bullish** setups only
- **Premium** (> 50%) → look for **bearish** setups only
- **Equilibrium** → both directions valid, lower confidence bonus

## Architecture

```
src/
├── crawlers/        WebSocket feeds (Binance, Bybit, OKX, BingX, Bitget, Gate, Hyperliquid)
├── orderbook/       Multi-exchange aggregator
├── sentiment/       Fear & Greed, funding, news
├── ict/             ICT engine — structure, OB, FVG, QM, RBS, POI stacks, setup scoring
├── screener/        Multi-symbol scanner (top-40 perps, 5-min interval)
├── trading/         Bot, risk manager, Binance Futures REST client
└── ui/              Ink (React TUI) components
```

The ICT engine uses a **3-tier update system** for performance:
1. **Candle close** → recompute POIs for that timeframe
2. **Live tick** → refresh price + POI zone responses (throttled to 4 Hz)
3. **Post-close** → full analysis: rebuild stacks, re-score setups

## Supported Exchanges (Order Book)

Binance · Bybit · OKX · BingX · Bitget · Gate.io · Hyperliquid

> ICT analysis and trading execution are Binance Futures only. Adding other brokers requires implementing a new `client.ts`.

## Contributing

PRs welcome. A few things to know:

- **No test suite** — manual testing via `bun start --no-bot`
- **Type-check before pushing**: `bun run typecheck`
- New POI types should implement the `POI` interface in `src/ict/types.ts` and go through the `poi.ts` normalization layer
- New exchanges need a crawler in `src/crawlers/` extending `BaseCrawler`
- See [CLAUDE.md](./CLAUDE.md) for deeper architecture notes

---

Built with [Bun](https://bun.sh) + [Ink](https://github.com/vadimdemedes/ink) + ICT methodology.
