import type { Candle, OrderBlock, Timeframe } from "./types.ts";

const isBull = (c: Candle) => c.close > c.open;
const isBear = (c: Candle) => c.close < c.open;
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);
const bodySize = (c: Candle) => Math.abs(c.close - c.open);

export function findOrderBlocks(
  candles: readonly Candle[],
  tf: Timeframe,
): OrderBlock[] {
  const closed = candles.filter((c) => c.closed);
  if (closed.length < 3) return [];

  const obs: OrderBlock[] = [];
  const seen = new Set<number>();

  for (let i = 2; i < closed.length; i++) {
    const c1 = closed[i - 2];
    const c2 = closed[i - 1]; // OB candle (rejection + longer wick)
    const c3 = closed[i];     // impulse candle
    if (!c1 || !c2 || !c3) continue;
    if (seen.has(c2.openTime)) continue;

    // ── Bullish OB: [Bearish][Bearish w/ longer lower wick][Bullish impulse] ──
    if (isBear(c1) && isBear(c2) && isBull(c3)) {
      const wick1 = lowerWick(c1);
      const wick2 = lowerWick(c2);

      // c2 must sweep below c1 (rejection) AND have a longer lower wick
      const wickRejection = c2.low < c1.low && wick2 > wick1;
      // c3 must close above the top of the OB candle (breakout)
      const impulsive = c3.close > c2.open;
      // c2 body must be meaningful (not a doji)
      const hasBody = bodySize(c2) > 0;

      if (wickRejection && impulsive && hasBody) {
        seen.add(c2.openTime);
        obs.push({
          direction: "bull",
          top: c2.open,     // top of OB candle body
          bottom: c2.close, // meeting point of c2 and c3 = entry zone
          time: c2.openTime,
          mitigated: isMitigated("bull", c2.open, c2.close, closed, i + 1),
          timeframe: tf,
          wickStop: c3.low, // SL = lowest wick of c3 (impulse candle)
        });
      }
    }

    // ── Bearish OB: [Bullish][Bullish w/ longer upper wick][Bearish impulse] ──
    if (isBull(c1) && isBull(c2) && isBear(c3)) {
      const wick1 = upperWick(c1);
      const wick2 = upperWick(c2);

      // c2 must sweep above c1 (rejection) AND have a longer upper wick
      const wickRejection = c2.high > c1.high && wick2 > wick1;
      // c3 must close below the bottom of the OB candle (breakout down)
      const impulsive = c3.close < c2.open;
      const hasBody = bodySize(c2) > 0;

      if (wickRejection && impulsive && hasBody) {
        seen.add(c2.openTime);
        obs.push({
          direction: "bear",
          top: c2.close,    // meeting point of c2 and c3 = entry zone (bear)
          bottom: c2.open,  // bottom of OB candle body
          time: c2.openTime,
          mitigated: isMitigated("bear", c2.close, c2.open, closed, i + 1),
          timeframe: tf,
          wickStop: c3.high, // SL = highest wick of c3
        });
      }
    }
  }

  return obs;
}

// OB is mitigated when price closes inside the OB zone after it formed
function isMitigated(
  dir: "bull" | "bear",
  top: number,
  bottom: number,
  candles: readonly Candle[],
  startIdx: number,
): boolean {
  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    // For bull OB: mitigated when a bearish close enters the zone from above
    if (dir === "bull" && c.close <= top && c.close >= bottom) return true;
    // For bear OB: mitigated when a bullish close enters the zone from below
    if (dir === "bear" && c.close >= bottom && c.close <= top) return true;
  }
  return false;
}
