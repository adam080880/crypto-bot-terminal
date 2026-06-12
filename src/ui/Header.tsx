import React from "react";
import { Box, Text } from "ink";
import type { CrawlerStatus } from "../crawlers/base.ts";
import type { ExchangeId } from "../orderbook/aggregator.ts";
import type { ActiveView } from "./App.tsx";
import { EXCHANGES } from "../orderbook/aggregator.ts";

interface Props {
  symbol: string;
  statuses: Record<ExchangeId, CrawlerStatus>;
  lastUpdate: Date;
  activeView: ActiveView;
  price?: number;
  cols: number;
  hasBotLive?: boolean;
}

function statusDot(status: CrawlerStatus): { char: string; color: string } {
  switch (status) {
    case "connected":    return { char: "●", color: "green" };
    case "connecting":   return { char: "◌", color: "yellow" };
    case "disconnected": return { char: "○", color: "gray" };
    case "error":        return { char: "✕", color: "red" };
  }
}

function fmtPrice(n: number): string {
  if (n >= 10_000) return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (n >= 100)    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toFixed(4);
}

const VIEWS: ActiveView[] = ["book", "sentiment", "ict", "scan", "bot"];
const VIEW_LABELS: Record<ActiveView, string> = {
  book: "BOOK",
  sentiment: "SENT",
  ict: "ICT",
  scan: "SCAN",
  bot: "BOT",
};

export function Header({ symbol, statuses, lastUpdate, activeView, price, cols, hasBotLive }: Props) {
  const timeStr = lastUpdate.toLocaleTimeString("en-US", { hour12: false });
  const sep = <Text color="gray"> │ </Text>;

  const connectedCount = EXCHANGES.filter((ex) => statuses[ex] === "connected").length;
  const totalCount = EXCHANGES.length;

  return (
    <Box flexDirection="column" width={cols}>
      <Box paddingX={1} justifyContent="space-between">
        {/* Left: symbol + price + exchanges */}
        <Box gap={0} alignItems="center">
          <Text bold color="cyanBright">{symbol.replace("USDT", "").replace("USD", "")}</Text>
          <Text color="gray">/USDT</Text>
          {sep}
          {price !== undefined ? (
            <Text color="white" bold>${fmtPrice(price)}</Text>
          ) : (
            <Text color="gray" dimColor>loading…</Text>
          )}
          {sep}
          <Box gap={1}>
            {EXCHANGES.map((ex) => {
              const dot = statusDot(statuses[ex]);
              return <Text key={ex} color={dot.color}>{dot.char}</Text>;
            })}
            <Text color={connectedCount === totalCount ? "green" : connectedCount > 0 ? "yellow" : "red"}>
              {connectedCount}/{totalCount}
            </Text>
          </Box>
          {hasBotLive && (
            <>
              {sep}
              <Text color="greenBright" bold>⚡ BOT LIVE</Text>
            </>
          )}
        </Box>

        {/* Right: tabs + time */}
        <Box gap={0} alignItems="center">
          <Box gap={1}>
            {VIEWS.map((view) => {
              const active = activeView === view;
              const isBotTab = view === "bot";
              return (
                <Text
                  key={view}
                  color={active ? "black" : isBotTab && hasBotLive ? "greenBright" : "gray"}
                  bold={active || (isBotTab && hasBotLive)}
                  backgroundColor={active ? (isBotTab ? "green" : "cyan") : undefined}
                >
                  {` ${VIEW_LABELS[view]} `}
                </Text>
              );
            })}
          </Box>
          {sep}
          <Text color="gray">{timeStr}</Text>
        </Box>
      </Box>

      <Text color="gray" dimColor>{"─".repeat(cols)}</Text>
    </Box>
  );
}
