# ICT Trading Terminal

> **EXPERIMENT ONLY** — This is a personal research project, not a production trading system. Do not use real funds without fully understanding the code and the risks involved.

A terminal-based (TUI) algorithmic trading tool for Binance Futures, built on **ICT (Inner Circle Trader)** concepts. Detects institutional setups (Order Blocks, FVGs, Quasimodo, SR Flips) across multiple timeframes, scores them into high-confidence setups, and optionally auto-trades them.

## Stack

- **Runtime**: [Bun](https://bun.sh) (no Node.js required)
- **Language**: TypeScript (ESM, strict)
- **UI**: [Ink](https://github.com/vadimdemedes/ink) — React in the terminal
- **Exchange**: Binance Futures (REST + WebSocket)

## Getting Started

```bash
bun install

# Watch-only mode (no trading — no API key needed)
bun start --no-bot

# Full bot mode — prompts for Binance Futures API key/secret at startup
bun start

# Target a specific symbol (default: BTCUSDT)
bun start ETHUSDT
```

> **API key requirements**: Futures trading enabled, IP whitelisting recommended. Keys are never written to disk — memory only.

## Project Structure

```
src/
├── crawlers/        # WebSocket order book feeds (Binance, Bybit, OKX, BingX, Bitget, Gate, Hyperliquid)
├── orderbook/       # Multi-exchange aggregator + depth book
├── sentiment/       # Fear & Greed index, funding rates, news aggregation
├── ict/             # Core ICT analysis engine
│   ├── engine.ts        # Main ICTEngine (EventEmitter, tiered update system)
│   ├── types.ts         # All shared types (Candle, POI, ICTSetup, ICTSnapshot…)
│   ├── candleFetcher.ts # Binance kline WebSocket with REST seed
│   ├── structure.ts     # Swing detection, BOS/CHoCH labeling
│   ├── orderBlock.ts    # Order Block detection (c1-c2-c3 pattern)
│   ├── fvg.ts           # Fair Value Gap detection
│   ├── rbs.ts           # Resistance-Becomes-Support / SR Flip
│   ├── quasimodo.ts     # Quasimodo (QM) pattern
│   ├── poi.ts           # POI normalization + POI Stack builder
│   ├── premiumDiscount.ts # Premium/Discount/Equilibrium zones
│   ├── killzone.ts      # Asia / London / New York session detection
│   ├── atr.ts           # ATR calculation (used for sizing + zone buffering)
│   ├── marketPhase.ts   # Accumulation / Markup / Distribution / Markdown
│   └── setupDetector.ts # CB1 / CB2 / CR setup scoring
├── screener/        # Multi-symbol scanner (top 40 USDT perps, 5-min interval)
│   ├── engine.ts        # ScreenerEngine — batch scans, ranks by setup confidence
│   └── symbols.ts       # Fetches top-volume symbols from Binance
├── trading/
│   ├── bot.ts           # TradingBot — listens to BotPool, executes on triggered setups
│   ├── botPool.ts       # BotPool — spins up live ICTEngines for top screener candidates
│   ├── client.ts        # BinanceFuturesClient — HMAC-signed REST wrapper
│   ├── prompt.ts        # CLI prompts for credentials + bot config
│   ├── riskManager.ts   # Position sizing (risk % → qty with leverage + step size)
│   └── types.ts         # TradeRecord, BotSnapshot, BinanceAccountBalance…
└── ui/
    ├── App.tsx          # Root layout, keyboard nav (Tab to switch views)
    ├── Header.tsx       # Symbol + price + kill zone status bar
    ├── ICTView.tsx      # POIs, setups, structure events, premium/discount
    ├── ScreenerView.tsx # Multi-symbol setup table (scrollable)
    ├── BotView.tsx      # Active trades, balance, last error
    ├── AggregatedBook.tsx # Cross-exchange order book depth
    ├── SentimentView.tsx  # Funding rates, fear & greed, news
    └── StatusBar.tsx    # Bottom bar — last update, scan progress
```

## ICT Concepts Implemented

### Points of Interest (POI)

| Kind | Description |
|------|-------------|
| `OB` | Order Block — last opposing candle before a displacement move |
| `FVG` | Fair Value Gap — imbalance between c1.high and c3.low (bull) or c1.low and c3.high (bear) |
| `RBS` | Resistance-Becomes-Support (and `SBR`) — SR flip after multiple tests |
| `QM` | Quasimodo — failed swing continuation that traps breakout traders |

POIs are normalized to a unified `POI` interface (top/bottom/mid/timeframe/group/response) so all setup detection logic is POI-kind-agnostic.

### POI Stacks

A `POIStack` is formed when POIs from multiple timeframe groups (`macro: 1w/1d`, `intermediate: 4h/1h`, `entry: 15m/5m/1m`) overlap spatially. Deeper stacks (more layers, more groups covered) get higher confidence. This is the multi-timeframe confluence check.

### Setup Types

| Type | Description |
|------|-------------|
| `CB1` | **Candle Back 1** — price retraces into a POI stack after a confirmed structural move |
| `CB2` | **Candle Back 2** — same as CB1 but entry triggers from a fresh LTF valid POI inside the HTF zone |
| `CR`  | **Continuation Reversal** — POI stack at premium/discount extreme with aligned HTF trend |

Each setup carries `entry`, `zoneTop/Bottom`, `stop`, `target`, `rr`, `confidence` (0–100), and `reasons[]`.

### HTF Trend & Bias

- 1D swings → `bullish` / `bearish` / `ranging` trend
- Premium zone (above equilibrium) in bullish trend → only bear POIs discarded
- Discount zone (below equilibrium) in bearish trend → only bull POIs discarded

### Kill Zones

Asia (00:00–04:00 UTC), London (07:00–10:00 UTC), New York (13:00–16:00 UTC). Setups forming during a kill zone get a confidence bonus.

## Trading Bot

The bot is **opt-in** and activates only when run without `--no-bot`.

**Flow:**
1. `ScreenerEngine` scans top-40 USDT perpetuals every 5 minutes, ranks by best setup confidence.
2. `BotPool` keeps live `ICTEngine` instances for the top N candidates.
3. `TradingBot` listens to pool updates. When a setup transitions to `triggered`, it fires a market order + SL + TP on Binance Futures.

**Risk config (prompted at startup):**

| Parameter | Default | Description |
|-----------|---------|-------------|
| Risk normal | 1% | % of available balance per trade |
| Risk high-conf | 5% | Used when setup confidence ≥ 60 |
| Max open trades | 3 | Hard cap on concurrent positions |
| Min confidence | 60 | Setups below this are skipped |

Leverage is set to max per symbol automatically. Position size is calculated so that a stop-out loses exactly `riskPct × balance` regardless of leverage.

**Startup safety check:**

On `start()`, the bot calls `loadHistoryCooldown()` which hits `/fapi/v1/income?incomeType=REALIZED_PNL` for the last 2 hours. Any symbol with realized PnL during that window is added to `historyCooldown` (a `Map<symbol, expiryTimestamp>` where `expiry = tradeTime + 2h`). `onPoolUpdate` skips those symbols until their cooldown expires. This prevents re-entry after a position that closed before the bot was restarted.

Separately, `loadExistingPositions()` imports any currently open Binance positions into the trades map so `syncPositions` can track and clean up their SL/TP orders.

## Screener View

The Scan tab shows setups in a two-column grid sorted by confidence (active → watching). The grid is **scrollable**:

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll one row |
| `PgUp` / `PgDn` | Scroll 10 rows |
| `Home` | Jump to top |

The grid auto-fits to terminal height (`terminalRows - OVERHEAD`). Symbols with no active setup are not shown in the list — only the count appears in the header (e.g. `113 no setup`).

## Update Architecture (ICTEngine)

Three-tier update system to balance CPU vs. responsiveness:

1. **Tier 1 — candle close**: recomputes POIs for that timeframe only (expensive, infrequent)
2. **Tier 2 — live tick**: refreshes price + POI responses at max 4 Hz (lightweight)
3. **Tier 3 — full analysis**: runs on candle close after Tier 1, rebuilds stacks + setups

## Key Conventions

- All monetary values are in USDT (quote currency)
- `closed: boolean` on `Candle` distinguishes a live building candle from a confirmed close
- `consumed: boolean` on `POI` marks a zone that price has passed through — excluded from new setups
- Setup IDs are deterministic (`${symbol}-${type}-${direction}-${Math.round(entry)}-${Math.round(stop)}`) so the same setup is never double-executed
- The screener and bot are **exchange-agnostic** at the setup-detection level; only `BinanceFuturesClient` is exchange-specific

## Development

```bash
bun run typecheck   # tsc --noEmit
```

No test suite currently. For UI changes, run with `--no-bot` and navigate views with `Tab`.
