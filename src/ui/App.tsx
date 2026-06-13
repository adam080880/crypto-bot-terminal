import React, { useState, useEffect, useRef } from "react";
import { useApp, useStdout, Box } from "ink";
import type { Aggregator, AggregatedBook as AggBook } from "../orderbook/aggregator.ts";
import type { SentimentAggregator } from "../sentiment/aggregator.ts";
import type { SentimentSnapshot } from "../sentiment/types.ts";
import type { ICTEngine } from "../ict/engine.ts";
import type { ICTSnapshot } from "../ict/types.ts";
import type { ScreenerEngine } from "../screener/engine.ts";
import type { ScreenerSnapshot } from "../screener/types.ts";
import type { TradingBot } from "../trading/bot.ts";
import type { BotSnapshot } from "../trading/types.ts";
import { Header } from "./Header.tsx";
import { AggregatedBook } from "./AggregatedBook.tsx";
import { SentimentView } from "./SentimentView.tsx";
import { ICTView } from "./ICTView.tsx";
import { ScreenerView } from "./ScreenerView.tsx";
import { BotView } from "./BotView.tsx";
import { StatusBar } from "./StatusBar.tsx";

export const TICK_SIZES = [0.1, 1, 10, 100, 1000] as const;
export type ActiveView = "book" | "sentiment" | "ict" | "scan" | "bot";

const VIEW_ORDER: ActiveView[] = ["book", "sentiment", "ict", "scan", "bot"];

const EMPTY_BOT_SNAPSHOT: BotSnapshot = {
  running: false,
  balance: null,
  trades: [],
  lastError: null,
  lastUpdated: 0,
  watchedSymbols: [],
};

interface Props {
  aggregator: Aggregator;
  sentimentAggregator: SentimentAggregator;
  ictEngine: ICTEngine;
  screenerEngine: ScreenerEngine;
  tradingBot?: TradingBot;
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  memLimitMB: number;
}

export function App({ aggregator, sentimentAggregator, ictEngine, screenerEngine, tradingBot, symbol, onSymbolChange, memLimitMB }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [activeView, setActiveView] = useState<ActiveView>("book");
  const [currentSymbol, setCurrentSymbol] = useState(symbol);
  const [inputMode, setInputMode] = useState(false);
  const [inputBuffer, setInputBuffer] = useState("");
  const [depth, setDepth] = useState(10);
  const [tickIdx, setTickIdx] = useState(1);
  const tickSize = TICK_SIZES[tickIdx]!;
  const [book, setBook] = useState<AggBook>(aggregator.getBook(depth, tickSize));
  const [sentiment, setSentiment] = useState<SentimentSnapshot>(sentimentAggregator.get());
  const [ict, setIct] = useState<ICTSnapshot>(ictEngine.get());
  const [screener, setScreener] = useState<ScreenerSnapshot>(screenerEngine.get());
  const [botSnap, setBotSnap] = useState<BotSnapshot>(EMPTY_BOT_SNAPSHOT);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [midPrice, setMidPrice] = useState<number | undefined>(undefined);
  const [memUsedMB, setMemUsedMB] = useState(() => Math.round(process.memoryUsage().rss / 1_048_576));
  const [scanScroll, setScanScroll] = useState(0);
  const scanScrollRef = useRef(scanScroll);
  useEffect(() => { scanScrollRef.current = scanScroll; }, [scanScroll]);

  useEffect(() => {
    const handler = () => {
      setBook(aggregator.getBook(depth, tickSize));
      const mid = aggregator.getMidPrice();
      if (mid !== undefined) setMidPrice(mid);
      setLastUpdate(new Date());
    };
    aggregator.on("update", handler);
    return () => { aggregator.off("update", handler); };
  }, [aggregator, depth, tickSize]);

  useEffect(() => {
    setBook(aggregator.getBook(depth, tickSize));
  }, [aggregator, depth, tickSize]);

  useEffect(() => {
    const handler = () => setSentiment(sentimentAggregator.get());
    sentimentAggregator.on("update", handler);
    return () => { sentimentAggregator.off("update", handler); };
  }, [sentimentAggregator]);

  useEffect(() => {
    const handler = () => {
      const snap = ictEngine.get();
      setIct(snap);
      setLastUpdate(new Date());
      if (midPrice === undefined && snap.price > 0) setMidPrice(snap.price);
    };
    ictEngine.on("update", handler);
    return () => { ictEngine.off("update", handler); };
  }, [ictEngine, midPrice]);

  useEffect(() => {
    const handler = () => setScreener(screenerEngine.get());
    screenerEngine.on("update", handler);
    return () => { screenerEngine.off("update", handler); };
  }, [screenerEngine]);

  useEffect(() => {
    if (!tradingBot) return;
    const handler = () => setBotSnap(tradingBot.getSnapshot());
    tradingBot.on("update", handler);
    return () => { tradingBot.off("update", handler); };
  }, [tradingBot]);

  useEffect(() => {
    setMidPrice(undefined);
    setIct(ictEngine.get());
  }, [currentSymbol, ictEngine]);

  useEffect(() => {
    const timer = setInterval(() => {
      setMemUsedMB(Math.round(process.memoryUsage().rss / 1_048_576));
    }, 5_000);
    return () => clearInterval(timer);
  }, []);

  const cols = stdout?.columns ?? 120;
  const rows = stdout?.rows ?? 40;

  // Refs so keypress handler sees latest values without re-registering
  const activeViewRef = useRef(activeView);
  const inputModeRef  = useRef(inputMode);
  const inputBufRef   = useRef(inputBuffer);
  useEffect(() => { activeViewRef.current = activeView; },   [activeView]);
  useEffect(() => { inputModeRef.current  = inputMode; },    [inputMode]);
  useEffect(() => { inputBufRef.current   = inputBuffer; },  [inputBuffer]);

  useEffect(() => {
    type Key = { name?: string; shift?: boolean; ctrl?: boolean };

    const handler = (str: string | undefined, key: Key) => {
      // ── Symbol input mode ──────────────────────────────────────────────────
      if (inputModeRef.current) {
        if (key?.name === "escape") {
          setInputMode(false);
          setInputBuffer("");
          return;
        }
        if (key?.name === "return") {
          const raw = inputBufRef.current.trim().toUpperCase();
          if (raw.length > 0) {
            // Auto-append USDT if user typed just the base (e.g. "ETH")
            const sym = raw.endsWith("USDT") || raw.endsWith("BUSD") ? raw : `${raw}USDT`;
            setCurrentSymbol(sym);
            onSymbolChange(sym);
          }
          setInputMode(false);
          setInputBuffer("");
          return;
        }
        if (key?.name === "backspace") {
          setInputBuffer((b) => b.slice(0, -1));
          return;
        }
        // Accept printable chars (letters/digits only for symbol names)
        if (str && str.length === 1 && /[a-zA-Z0-9]/.test(str)) {
          setInputBuffer((b) => b + str.toUpperCase());
        }
        return; // swallow everything else in input mode
      }

      // ── Normal mode ────────────────────────────────────────────────────────
      if ((key?.ctrl && key?.name === "c") || str === "q") { exit(); return; }

      // / → enter symbol input mode
      if (str === "/") { setInputMode(true); setInputBuffer(""); return; }

      // Tab navigation
      if (key?.name === "tab") {
        if (key.shift) {
          setActiveView((v) => {
            const i = VIEW_ORDER.indexOf(v);
            return VIEW_ORDER[(i - 1 + VIEW_ORDER.length) % VIEW_ORDER.length]!;
          });
        } else {
          setActiveView((v) => {
            const i = VIEW_ORDER.indexOf(v);
            return VIEW_ORDER[(i + 1) % VIEW_ORDER.length]!;
          });
        }
        return;
      }

      // Order book controls
      if (activeViewRef.current === "book") {
        if (str === "+" || str === "=") setDepth((d) => Math.min(d + 5, 50));
        if (str === "-")                 setDepth((d) => Math.max(d - 5, 5));
        if (str === "]")                 setTickIdx((i) => Math.min(i + 1, TICK_SIZES.length - 1));
        if (str === "[")                 setTickIdx((i) => Math.max(i - 1, 0));
      }

      // Scan scroll
      if (activeViewRef.current === "scan") {
        if (key?.name === "up")       setScanScroll((s) => Math.max(0, s - 1));
        if (key?.name === "down")     setScanScroll((s) => s + 1);
        if (key?.name === "pageup")   setScanScroll((s) => Math.max(0, s - 10));
        if (key?.name === "pagedown") setScanScroll((s) => s + 10);
        if (key?.name === "home")     setScanScroll(0);
      }
    };

    process.stdin.on("keypress", handler as (...a: unknown[]) => void);
    return () => { process.stdin.off("keypress", handler as (...a: unknown[]) => void); };
  }, [exit, onSymbolChange]);

  const displayPrice = midPrice ?? (ict.price > 0 ? ict.price : undefined);
  const hasBotLive = tradingBot !== undefined && botSnap.running;

  return (
    <Box flexDirection="column" width={cols}>
      <Header
        symbol={currentSymbol}
        statuses={book.statuses}
        lastUpdate={lastUpdate}
        activeView={activeView}
        price={displayPrice}
        cols={cols}
        hasBotLive={hasBotLive}
        inputMode={inputMode}
        inputBuffer={inputBuffer}
      />
      {activeView === "book" && (
        <>
          <Box marginY={1} flexDirection="column">
            <AggregatedBook book={book} depth={depth} tickSize={tickSize} cols={cols} />
          </Box>
          <StatusBar depth={depth} tickSize={tickSize} memUsedMB={memUsedMB} memLimitMB={memLimitMB} />
        </>
      )}
      {activeView === "sentiment" && <SentimentView snapshot={sentiment} />}
      {activeView === "ict"       && <ICTView snapshot={ict} />}
      {activeView === "scan"      && <ScreenerView snapshot={screener} scrollTop={scanScroll} terminalRows={rows} setScanScroll={setScanScroll} />}
      {activeView === "bot"       && <BotView snapshot={botSnap} ict={ict} />}
    </Box>
  );
}
