import React from "react";
import { render } from "ink";
import { emitKeypressEvents } from "readline";
import { BinanceCrawler } from "./crawlers/binance.ts";
import { BybitCrawler } from "./crawlers/bybit.ts";
import { OkxCrawler } from "./crawlers/okx.ts";
import { BingxCrawler } from "./crawlers/bingx.ts";
import { BitgetCrawler } from "./crawlers/bitget.ts";
import { GateCrawler } from "./crawlers/gate.ts";
import { HyperliquidCrawler } from "./crawlers/hyperliquid.ts";
import { Aggregator } from "./orderbook/aggregator.ts";
import { SentimentAggregator } from "./sentiment/aggregator.ts";
import { ICTEngine } from "./ict/engine.ts";
import { ScreenerEngine } from "./screener/engine.ts";
import { BinanceFuturesClient } from "./trading/client.ts";
import { BotPool } from "./trading/botPool.ts";
import { TradingBot } from "./trading/bot.ts";
import { promptCredentials, promptBotConfig } from "./trading/prompt.ts";
import { App } from "./ui/App.tsx";

const args = process.argv.slice(2);
const noBot = args.includes("--no-bot");
const symbol = args.find((a) => !a.startsWith("-")) ?? "BTCUSDT";

const MEM_LIMIT_MB = 10_240; // 10 GB — soft reset triggers when RSS exceeds this
let currentSymbol = symbol;

// ─── Core engines (declared first so bot can reference ictEngine) ───────────
const crawlers = [
  new BinanceCrawler(),
  new BybitCrawler(),
  new OkxCrawler(),
  new BingxCrawler(),
  new BitgetCrawler(),
  new GateCrawler(),
  new HyperliquidCrawler(),
];

const aggregator = new Aggregator(crawlers);
const sentimentAggregator = new SentimentAggregator();
const ictEngine = new ICTEngine();
const screenerEngine = new ScreenerEngine();

// ─── Optional: prompt credentials + set up bot ─────────────────────────────
let tradingBot: TradingBot | undefined;
let botPool: BotPool | undefined;

if (!noBot) {
  const creds = await promptCredentials();

  process.stdout.write("  Validating credentials… ");
  const client = new BinanceFuturesClient(creds.apiKey, creds.apiSecret);
  const valid = await client.ping();

  if (!valid) {
    process.stdout.write("✗ Invalid API key or secret. Check your Binance Futures API settings.\n");
    process.exit(1);
  }
  process.stdout.write("✓ Connected\n\n");

  const botConfig = await promptBotConfig();
  process.stdout.write("\n");

  botPool    = new BotPool(screenerEngine, symbol);
  tradingBot = new TradingBot(botPool, client, botConfig);
}

// ─── Keyboard input setup ────────────────────────────────────────────────────
// emitKeypressEvents makes readline parse raw bytes into structured key objects
// (name, shift, ctrl, etc.) so our 'keypress' listener in App.tsx works.
// setRawMode sends individual keystrokes immediately instead of line-buffered.
emitKeypressEvents(process.stdin);
if (process.stdin.setRawMode) {
  try { process.stdin.setRawMode(true); } catch {}
}
process.stdin.resume();

// ─── Enter fullscreen alternate screen ─────────────────────────────────────
if (process.stdout.isTTY) {
  process.stdout.write("\x1b[?1049h"); // enter alternate screen
  process.stdout.write("\x1b[H");      // cursor to top-left
}

// ─── Symbol switch — restarts per-symbol engines, leaves global ones alone ──
function changeSymbol(newSymbol: string): void {
  currentSymbol = newSymbol;

  for (const crawler of crawlers) crawler.disconnect();
  sentimentAggregator.stop();
  ictEngine.stop();

  for (const crawler of crawlers) {
    crawler.connect(newSymbol).catch((err: Error) => {
      console.error(`[${crawler.exchange}] reconnect error:`, err.message);
    });
  }
  sentimentAggregator.start(newSymbol);
  ictEngine.start(newSymbol);
  // screenerEngine and botPool/tradingBot are global — intentionally not restarted
}

// ─── Soft reset — clears all engine state, preserves auth + open trades ─────
// Stops/restarts crawlers, sentiment, ICT engine, and screener.
// BotPool and TradingBot are intentionally left running so open positions and
// API credentials survive the reset.
async function softReset(): Promise<void> {
  for (const crawler of crawlers) crawler.disconnect();
  sentimentAggregator.stop();
  ictEngine.stop();
  screenerEngine.stop();

  await new Promise<void>((r) => setTimeout(r, 300));

  for (const crawler of crawlers) {
    crawler.connect(currentSymbol).catch((err: Error) => {
      console.error(`[${crawler.exchange}] reset reconnect error:`, err.message);
    });
  }
  sentimentAggregator.start(currentSymbol);
  ictEngine.start(currentSymbol);
  screenerEngine.start();
}

// ─── Memory watchdog — polls every 30s, triggers soft reset at limit ─────────
setInterval(() => {
  const mb = Math.round(process.memoryUsage().rss / 1_048_576);
  if (mb >= MEM_LIMIT_MB) {
    softReset().catch((err: Error) => console.error("[memory] reset error:", err.message));
  }
}, 30_000);

// ─── Render UI ─────────────────────────────────────────────────────────────
const { unmount } = render(
  React.createElement(App, {
    aggregator,
    sentimentAggregator,
    ictEngine,
    screenerEngine,
    tradingBot,
    symbol,
    onSymbolChange: changeSymbol,
    memLimitMB: MEM_LIMIT_MB,
  }),
  { exitOnCtrlC: false }
);

// ─── Connect everything ─────────────────────────────────────────────────────
for (const crawler of crawlers) {
  crawler.connect(symbol).catch((err: Error) => {
    console.error(`[${crawler.exchange}] connect error:`, err.message);
  });
}

sentimentAggregator.start(symbol);
ictEngine.start(symbol);
screenerEngine.start();

// Bot starts after ICT has had a moment to warm up
if (tradingBot) {
  setTimeout(() => {
    tradingBot!.start().catch((err: Error) => {
      console.error("[bot] start error:", err.message);
    });
  }, 5_000);
}

// ─── Shutdown ───────────────────────────────────────────────────────────────
function shutdown() {
  tradingBot?.stop();
  botPool?.stop();
  for (const crawler of crawlers) crawler.disconnect();
  sentimentAggregator.stop();
  ictEngine.stop();
  screenerEngine.stop();
  unmount();
  if (process.stdout.isTTY) process.stdout.write("\x1b[?1049l");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
