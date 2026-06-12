import type { Candle, Timeframe } from "./types.ts";
import { calcATR } from "./atr.ts";

export interface SRFlip {
  kind: "RBS" | "SBR";
  price: number;    // exact swing level
  top: number;      // zone top (price + buffer)
  bottom: number;   // zone bottom (price - buffer)
  time: number;     // when the original swing formed
  breakTime: number; // when price broke through (flip confirmed)
  timeframe: Timeframe;
  invalidated: boolean; // true if price later closed through the zone
  touchCount: number;   // how many times price tested the level before breaking
}

export function findSRFlips(
  candles: readonly Candle[],
  tf: Timeframe,
  lookback = 2,
): SRFlip[] {
  const closed = candles.filter((c) => c.closed);
  if (closed.length < lookback * 2 + 4) return [];

  const atr = calcATR(closed);
  if (atr === 0) return [];

  const buf = atr * 0.3;
  const flips: SRFlip[] = [];
  const seenSwingTime = new Set<number>();

  for (let i = lookback; i < closed.length - lookback; i++) {
    const c = closed[i];
    if (!c || seenSwingTime.has(c.openTime)) continue;

    // ── Swing High → potential RBS ──────────────────────────────────────────
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if ((closed[i - j]?.high ?? 0) >= c.high || (closed[i + j]?.high ?? 0) >= c.high) {
        isSwingHigh = false; break;
      }
    }

    if (isSwingHigh) {
      const resistanceLevel = c.high;

      // Count how many times price touched within buffer before breaking
      let touchCount = 0;
      let breakIdx = -1;

      for (let j = i + 1; j < closed.length; j++) {
        const fc = closed[j];
        if (!fc) continue;
        const nearLevel = fc.high >= resistanceLevel - buf && fc.high <= resistanceLevel + buf * 3;
        if (nearLevel && fc.close < resistanceLevel) touchCount++;
        // Break above = close above resistance + small buffer
        if (fc.close > resistanceLevel + atr * 0.05) { breakIdx = j; break; }
      }

      if (breakIdx > 0) {
        const breakC = closed[breakIdx];
        if (!breakC) continue;

        // Check if still valid (not invalidated by later close well below level)
        let invalidated = false;
        for (let j = breakIdx + 1; j < closed.length; j++) {
          const fc = closed[j];
          if (!fc) continue;
          if (fc.close < resistanceLevel - atr) { invalidated = true; break; }
        }

        seenSwingTime.add(c.openTime);
        flips.push({
          kind: "RBS",
          price: resistanceLevel,
          top: resistanceLevel + buf,
          bottom: resistanceLevel - buf,
          time: c.openTime,
          breakTime: breakC.openTime,
          timeframe: tf,
          invalidated,
          touchCount: Math.max(1, touchCount),
        });
      }
    }

    // ── Swing Low → potential SBR ────────────────────────────────────────────
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if ((closed[i - j]?.low ?? Infinity) <= c.low || (closed[i + j]?.low ?? Infinity) <= c.low) {
        isSwingLow = false; break;
      }
    }

    if (isSwingLow) {
      const supportLevel = c.low;

      let touchCount = 0;
      let breakIdx = -1;

      for (let j = i + 1; j < closed.length; j++) {
        const fc = closed[j];
        if (!fc) continue;
        const nearLevel = fc.low <= supportLevel + buf && fc.low >= supportLevel - buf * 3;
        if (nearLevel && fc.close > supportLevel) touchCount++;
        if (fc.close < supportLevel - atr * 0.05) { breakIdx = j; break; }
      }

      if (breakIdx > 0) {
        const breakC = closed[breakIdx];
        if (!breakC) continue;

        let invalidated = false;
        for (let j = breakIdx + 1; j < closed.length; j++) {
          const fc = closed[j];
          if (!fc) continue;
          if (fc.close > supportLevel + atr) { invalidated = true; break; }
        }

        seenSwingTime.add(c.openTime);
        flips.push({
          kind: "SBR",
          price: supportLevel,
          top: supportLevel + buf,
          bottom: supportLevel - buf,
          time: c.openTime,
          breakTime: breakC.openTime,
          timeframe: tf,
          invalidated,
          touchCount: Math.max(1, touchCount),
        });
      }
    }
  }

  return flips;
}
