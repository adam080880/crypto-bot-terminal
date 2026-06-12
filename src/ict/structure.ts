import type { Candle, SwingPoint, StructureEvent, Trend } from "./types.ts";

export function findSwings(candles: readonly Candle[], lookback = 2): SwingPoint[] {
  const closed = candles.filter((c) => c.closed);
  const swings: SwingPoint[] = [];

  for (let i = lookback; i < closed.length - lookback; i++) {
    const c = closed[i];
    if (!c) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      const l = closed[i - j];
      const r = closed[i + j];
      if (!l || !r) { isHigh = false; isLow = false; break; }
      if (c.high <= l.high || c.high <= r.high) isHigh = false;
      if (c.low >= l.low || c.low >= r.low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, time: c.openTime, price: c.high, kind: "high" });
    if (isLow) swings.push({ index: i, time: c.openTime, price: c.low, kind: "low" });
  }

  return labelSwings(swings);
}

function labelSwings(swings: SwingPoint[]): SwingPoint[] {
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");

  for (let i = 0; i < highs.length; i++) {
    const curr = highs[i];
    const prev = highs[i - 1];
    if (!curr) continue;
    curr.label = i === 0 || !prev ? "HH" : curr.price > prev.price ? "HH" : "LH";
  }
  for (let i = 0; i < lows.length; i++) {
    const curr = lows[i];
    const prev = lows[i - 1];
    if (!curr) continue;
    curr.label = i === 0 || !prev ? "HL" : curr.price > prev.price ? "HL" : "LL";
  }

  return swings;
}

export function detectStructure(
  candles: readonly Candle[],
  swings: SwingPoint[],
): { trend: Trend; events: StructureEvent[] } {
  const events: StructureEvent[] = [];
  const closed = candles.filter((c) => c.closed);
  if (closed.length < 5 || swings.length < 2) return { trend: "ranging", events };

  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const lastHigh = highs.at(-1);
  const prevHigh = highs.at(-2);
  const lastLow = lows.at(-1);
  const prevLow = lows.at(-2);

  let trend: Trend = "ranging";
  if (lastHigh && prevHigh && lastLow && prevLow) {
    if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) trend = "bullish";
    else if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) trend = "bearish";
  }

  const lastCandle = closed.at(-1);
  if (!lastCandle) return { trend, events };

  // BOS bullish: close breaks above last swing high in bullish trend
  if (trend === "bullish" && lastHigh && lastCandle.close > lastHigh.price) {
    events.push({ type: "BOS", direction: "bull", level: lastHigh.price, time: lastCandle.openTime });
  }

  // BOS bearish: close breaks below last swing low in bearish trend
  if (trend === "bearish" && lastLow && lastCandle.close < lastLow.price) {
    events.push({ type: "BOS", direction: "bear", level: lastLow.price, time: lastCandle.openTime });
  }

  // CHoCH bullish: close breaks last LH while bearish → character change
  if (trend === "bearish") {
    const lastLH = highs.slice().reverse().find((h) => h.label === "LH");
    if (lastLH && lastCandle.close > lastLH.price) {
      events.push({ type: "CHoCH", direction: "bull", level: lastLH.price, time: lastCandle.openTime });
    }
  }

  // CHoCH bearish: close breaks last HL while bullish → character change
  if (trend === "bullish") {
    const lastHL = lows.slice().reverse().find((l) => l.label === "HL");
    if (lastHL && lastCandle.close < lastHL.price) {
      events.push({ type: "CHoCH", direction: "bear", level: lastHL.price, time: lastCandle.openTime });
    }
  }

  return { trend, events };
}
