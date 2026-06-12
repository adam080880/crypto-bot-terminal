import type { Candle, FVG, Timeframe } from "./types.ts";

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
