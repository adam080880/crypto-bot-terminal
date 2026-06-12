import type { Candle, SwingPoint, MarketPhase, Trend } from "./types.ts";
import { calcATR } from "./atr.ts";

export function detectPhase(
  candles: readonly Candle[],
  swings: SwingPoint[],
  trend: Trend,
): MarketPhase {
  const closed = candles.filter((c) => c.closed);
  if (closed.length < 20) return "accumulation";

  const atr = calcATR(closed);
  const recent = closed.slice(-20);
  const avgRange = recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length;
  const isLowVol = avgRange < atr * 0.8;

  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const lastHigh = highs.at(-1);
  const lastLow = lows.at(-1);

  if (trend === "bullish") {
    // Topping out: bullish but low vol at highs
    if (isLowVol && lastHigh) return "distribution";
    return "markup";
  }

  if (trend === "bearish") {
    // Bottoming out: bearish but low vol at lows
    if (isLowVol && lastLow) return "accumulation";
    return "markdown";
  }

  // Ranging: determine by recency of high vs low
  if (lastHigh && lastLow) {
    return lastHigh.time > lastLow.time ? "distribution" : "accumulation";
  }

  return "accumulation";
}
