import React from "react";
import { Box, Text } from "ink";
import type { AggregatedBook as AggBook, ExchangeId } from "../orderbook/aggregator.ts";

interface Props {
  book: AggBook;
  depth: number;
  tickSize: number;
  cols?: number;
}

function tickDecimals(tick: number): number {
  if (tick >= 1) return 0;
  return Math.ceil(-Math.log10(tick));
}

function fmtPrice(price: number, tick: number): string {
  const dec = tickDecimals(tick);
  return price.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }).padStart(14);
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 100_000)   return `${(n / 1000).toFixed(0)}K`;
  if (n >= 10_000)    return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1_000)     return `${(n / 1000).toFixed(2)}K`;
  if (n >= 100)       return n.toFixed(1);
  if (n >= 10)        return n.toFixed(2);
  if (n >= 1)         return n.toFixed(3);
  return n.toFixed(4);
}

function fmtQty(qty: number): string {
  return compact(qty).padStart(10);
}

function depthBar(qty: number, maxQty: number, width: number): string {
  if (maxQty === 0 || width <= 0) return " ".repeat(width);
  const filled = Math.round((qty / maxQty) * width);
  return "█".repeat(filled).padEnd(width);
}

export function AggregatedBook({ book, depth, tickSize, cols = 120 }: Props) {
  // Reserve space for: side(4) + price(14) + qty(10) + padding(4) = 32, rest for bar
  const barWidth = Math.max(10, Math.min(40, cols - 36));

  const allLevels = [...book.asks, ...book.bids];
  const maxQty = allLevels.reduce((m, l) => Math.max(m, l.totalQty), 0);

  const askLevels = book.asks.slice(0, depth).reverse();
  const bidLevels = book.bids.slice(0, depth);

  const spreadLine = () => {
    const bs = book.bestSpread;
    const as = book.aggSpread;
    const parts: string[] = [];
    if (bs !== undefined) parts.push(`best $${bs.value.toFixed(2)} (${bs.exchange})`);
    if (as !== undefined) parts.push(`agg $${as.toFixed(2)}`);
    return parts.join("  ·  ");
  };

  const colHeader = (
    <Box paddingX={1}>
      <Text color="gray" dimColor>{"Price".padStart(14)}</Text>
      <Text color="gray" dimColor>{"Qty".padStart(10)}</Text>
      <Text color="gray" dimColor>  {"Depth".padEnd(barWidth)}</Text>
    </Box>
  );

  const renderRow = (price: number, totalQty: number, side: "ask" | "bid") => {
    const color = side === "ask" ? "red" : "green";
    const bar = depthBar(totalQty, maxQty, barWidth);
    return (
      <Box key={`${side}-${price}`} paddingX={1}>
        <Text color={color}>{fmtPrice(price, tickSize)}</Text>
        <Text color={color}>{fmtQty(totalQty)}</Text>
        <Text color={side === "ask" ? "redBright" : "greenBright"} dimColor>  {bar}</Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      {colHeader}
      <Box flexDirection="column">
        {askLevels.map((l) => renderRow(l.price, l.totalQty, "ask"))}
      </Box>
      <Box paddingX={1} marginY={0}>
        <Text color="gray" dimColor>{"─".repeat(14 + 10 + barWidth + 4)}</Text>
        <Text color="yellow">  {spreadLine()}</Text>
      </Box>
      <Box flexDirection="column">
        {bidLevels.map((l) => renderRow(l.price, l.totalQty, "bid"))}
      </Box>
    </Box>
  );
}
