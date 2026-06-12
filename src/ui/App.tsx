import React, { useState, useEffect, useCallback } from "react";
import { useInput, useApp, useStdout, Box } from "ink";
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
};

interface Props {
  aggregator: Aggregator;
  sentimentAggregator: SentimentAggregator;
  ictEngine: ICTEngine;
  screenerEngine: ScreenerEngine;
  tradingBot?: TradingBot;
  symbol: string;
}

export function App({ aggregator, sentimentAggregator, ictEngine, screenerEngine, tradingBot, symbol }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [activeView, setActiveView] = useState<ActiveView>("book");
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

  const cols = stdout?.columns ?? 120;

  const isTTY = process.stdin.isTTY === true;
  useInput(useCallback((input, key) => {
    if (input === "q") exit();
    if (key.tab && !key.shift) setActiveView((v) => {
      const idx = VIEW_ORDER.indexOf(v);
      return VIEW_ORDER[(idx + 1) % VIEW_ORDER.length]!;
    });
    if (key.tab && key.shift) setActiveView((v) => {
      const idx = VIEW_ORDER.indexOf(v);
      return VIEW_ORDER[(idx - 1 + VIEW_ORDER.length) % VIEW_ORDER.length]!;
    });
    if (activeView === "book") {
      if (input === "+" || input === "=") setDepth((d) => Math.min(d + 5, 50));
      if (input === "-") setDepth((d) => Math.max(d - 5, 5));
      if (input === "]") setTickIdx((i) => Math.min(i + 1, TICK_SIZES.length - 1));
      if (input === "[") setTickIdx((i) => Math.max(i - 1, 0));
    }
  }, [exit, activeView]), { isActive: isTTY });

  const displayPrice = midPrice ?? (ict.price > 0 ? ict.price : undefined);
  const hasBotLive = tradingBot !== undefined && botSnap.running;

  return (
    <Box flexDirection="column" width={cols}>
      <Header
        symbol={symbol}
        statuses={book.statuses}
        lastUpdate={lastUpdate}
        activeView={activeView}
        price={displayPrice}
        cols={cols}
        hasBotLive={hasBotLive}
      />
      {activeView === "book" && (
        <>
          <Box marginY={1} flexDirection="column">
            <AggregatedBook book={book} depth={depth} tickSize={tickSize} cols={cols} />
          </Box>
          <StatusBar depth={depth} tickSize={tickSize} />
        </>
      )}
      {activeView === "sentiment" && <SentimentView snapshot={sentiment} />}
      {activeView === "ict"       && <ICTView snapshot={ict} />}
      {activeView === "scan"      && <ScreenerView snapshot={screener} />}
      {activeView === "bot"       && <BotView snapshot={botSnap} ict={ict} />}
    </Box>
  );
}
