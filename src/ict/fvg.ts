import type { Candle, FVG, IFVG, Timeframe } from "./types.ts";

export function findFVGs(candles: readonly Candle[], tf: Timeframe): FVG[] {
  const closed = candles.filter((c) => c.closed);
  const fvgs: FVG[] = [];

  for (let i = 2; i < closed.length; i++) {
    const a = closed[i - 2];
    const b = closed[i - 1];
    const c = closed[i];
    if (!a || !b || !c) continue;

    // Bull FVG: a.high < c.low — price gapped up strongly
    if (a.high < c.low) {
      fvgs.push({ direction: "bull", top: c.low, bottom: a.high, time: b.openTime, filled: false, timeframe: tf });
    }

    // Bear FVG: a.low > c.high — price gapped down strongly
    if (a.low > c.high) {
      fvgs.push({ direction: "bear", top: a.low, bottom: c.high, time: b.openTime, filled: false, timeframe: tf });
    }
  }

  return markFilled(fvgs, closed);
}

/**
 * Detect Inverse FVGs (iFVG).
 *
 * A raw FVG that price later *closes through* in the opposite direction flips
 * polarity and becomes a valid entry POI:
 *   - Bull FVG (a.high < c.low) closed below its bottom → bear iFVG (resistance)
 *   - Bear FVG (a.low  > c.high) closed above its top    → bull iFVG (support)
 *
 * The returned zone keeps the original FVG bounds but carries the flipped
 * direction. `invertTime` marks the candle that confirmed the break.
 */
export function findIFVGs(candles: readonly Candle[], tf: Timeframe): IFVG[] {
  const closed = candles.filter((c) => c.closed);
  const out: IFVG[] = [];

  for (let i = 2; i < closed.length; i++) {
    const a = closed[i - 2];
    const b = closed[i - 1];
    const c = closed[i];
    if (!a || !b || !c) continue;

    // Raw bull FVG → look for a later close below its bottom (a.high) → bear iFVG
    if (a.high < c.low) {
      const top = c.low;
      const bottom = a.high;
      for (let j = i + 1; j < closed.length; j++) {
        const fc = closed[j];
        if (!fc) continue;
        if (fc.close < bottom) {
          // Mitigated if price later trades back up into the flipped (resistance) zone
          const mitigated = closed.slice(j + 1).some((k) => k && k.high >= bottom);
          out.push({
            direction: "bear",
            top,
            bottom,
            time: b.openTime,
            filled: false,
            timeframe: tf,
            inverted: true,
            invertTime: fc.openTime,
          });
          if (mitigated) out[out.length - 1]!.filled = true;
          break;
        }
        // If price closes back above the top before breaking down, the FVG held — abandon
        if (fc.close > top) break;
      }
    }

    // Raw bear FVG → look for a later close above its top (a.low) → bull iFVG
    if (a.low > c.high) {
      const top = a.low;
      const bottom = c.high;
      for (let j = i + 1; j < closed.length; j++) {
        const fc = closed[j];
        if (!fc) continue;
        if (fc.close > top) {
          const mitigated = closed.slice(j + 1).some((k) => k && k.low <= top);
          out.push({
            direction: "bull",
            top,
            bottom,
            time: b.openTime,
            filled: false,
            timeframe: tf,
            inverted: true,
            invertTime: fc.openTime,
          });
          if (mitigated) out[out.length - 1]!.filled = true;
          break;
        }
        if (fc.close < bottom) break;
      }
    }
  }

  return out;
}

function markFilled(fvgs: FVG[], candles: readonly Candle[]): FVG[] {
  return fvgs.map((fvg) => {
    const startIdx = candles.findIndex((c) => c.openTime > fvg.time);
    if (startIdx < 0) return fvg;
    for (let i = startIdx; i < candles.length; i++) {
      const c = candles[i];
      if (!c) continue;
      if (fvg.direction === "bull" && c.low <= fvg.bottom) return { ...fvg, filled: true };
      if (fvg.direction === "bear" && c.high >= fvg.top) return { ...fvg, filled: true };
    }
    return fvg;
  });
}
