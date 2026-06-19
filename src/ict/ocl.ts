import type { Candle, OCL, Timeframe } from "./types.ts";
import { calcATR } from "./atr.ts";

/**
 * Detect OCL (Open/Close Candle) levels.
 *
 * Concept (Materi 2):
 *   - An OCL is the open/close of the candle immediately before a *displacement*
 *     move. That open/close price becomes a Point of Interest:
 *       · bullish displacement → the prior candle's close is new SUPPORT (bull OCL)
 *       · bearish displacement → the prior candle's close is new RESISTANCE (bear OCL)
 *   - "OCL Break": once a later candle closes back through that level, the broken
 *     level is a higher-probability POI (we keep it and flag `broken: true`).
 *
 * Heuristic for "displacement": the next candle's body is significantly larger
 * than the recent average body (≥ DISPLACEMENT_MULT×) and moves in one direction.
 */
const DISPLACEMENT_MULT = 1.2;
const BODY_LOOKBACK = 14;

function body(c: Candle): number {
  return Math.abs(c.close - c.open);
}

function avgBody(candles: readonly Candle[], end: number): number {
  const start = Math.max(0, end - BODY_LOOKBACK);
  let sum = 0;
  let n = 0;
  for (let i = start; i < end; i++) {
    const c = candles[i];
    if (!c) continue;
    sum += body(c);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

export function findOCLs(candles: readonly Candle[], tf: Timeframe): OCL[] {
  const closed = candles.filter((c) => c.closed);
  if (closed.length < BODY_LOOKBACK + 2) return [];

  const atr = calcATR(closed);
  if (atr === 0) return [];

  const buf = atr * 0.2;
  const out: OCL[] = [];
  const seen = new Set<number>();

  // i = the displacement candle; i-1 = the OCL candle whose close we mark.
  for (let i = 1; i < closed.length; i++) {
    const prev = closed[i - 1];
    const disp = closed[i];
    if (!prev || !disp) continue;

    const avg = avgBody(closed, i);
    if (avg <= 0) continue;
    if (body(disp) < avg * DISPLACEMENT_MULT) continue;

    const isBullDisp = disp.close > disp.open && disp.close > prev.high;
    const isBearDisp = disp.close < disp.open && disp.close < prev.low;
    if (!isBullDisp && !isBearDisp) continue;

    const direction = isBullDisp ? "bull" : "bear";
    const level = prev.close; // OCL = close of the candle before displacement
    if (seen.has(prev.openTime)) continue;
    seen.add(prev.openTime);

    // OCL Break detection + mitigation: scan candles after the displacement.
    let broken = false;
    let breakTime: number | undefined;
    let mitigated = false;
    for (let j = i + 1; j < closed.length; j++) {
      const fc = closed[j];
      if (!fc) continue;
      // Price traded back into the level zone (mitigation / retest)
      if (fc.low <= level + buf && fc.high >= level - buf) mitigated = true;
      // OCL Break = a later candle closes back through the level the wrong way
      if (!broken) {
        if (direction === "bull" && fc.close < level - buf) { broken = true; breakTime = fc.openTime; }
        if (direction === "bear" && fc.close > level + buf) { broken = true; breakTime = fc.openTime; }
      }
    }

    out.push({
      direction,
      level,
      top: level + buf,
      bottom: level - buf,
      time: prev.openTime,
      timeframe: tf,
      broken,
      breakTime,
      mitigated,
    });
  }

  return out;
}
