import type { Candle, Timeframe } from "./types.ts";
import { findSwings } from "./structure.ts";
import { calcATR } from "./atr.ts";

export interface QuasimodoPattern {
  direction: "bull" | "bear";
  // The QM zone = where Mountain3 ≈ Mountain1 (the entry area)
  level: number;       // midpoint of M1 and M3
  top: number;
  bottom: number;
  // Key prices
  m1Price: number;     // Mountain/Valley 1
  m2Price: number;     // Mountain/Valley 2 (the extreme — used as SL)
  m3Price: number;     // Mountain/Valley 3 (the entry trigger)
  time: number;        // when M3 formed (most recent)
  timeframe: Timeframe;
  invalidated: boolean; // price broke past M2 after M3 formed
}

export function findQuasimodo(candles: readonly Candle[], tf: Timeframe): QuasimodoPattern[] {
  const closed = candles.filter((c) => c.closed);
  if (closed.length < 10) return [];

  const atr = calcATR(closed);
  if (atr === 0) return [];

  const swings = findSwings(closed, 2);
  const patterns: QuasimodoPattern[] = [];
  const seenTime = new Set<number>();

  // ── Bearish QM: M1(high) → M2(higher high) → M3(lower high, ≈ M1) ─────────
  // M3 is the SHORT entry — market failed to break M2 and returns to M1 level
  const highs = swings.filter((s) => s.kind === "high");
  for (let i = 2; i < highs.length; i++) {
    const m1 = highs[i - 2];
    const m2 = highs[i - 1];
    const m3 = highs[i];
    if (!m1 || !m2 || !m3) continue;
    if (seenTime.has(m3.time)) continue;

    const isQM =
      m2.price > m1.price &&          // M2 is higher (the peak)
      m3.price < m2.price &&          // M3 fails to reach M2 (key QM criterion)
      m3.price > m1.price - atr &&    // M3 is near M1 level (not drastically lower)
      m3.price < m1.price + atr * 2;  // M3 not far above M1

    if (!isQM) continue;

    const qmLevel = (m1.price + m3.price) / 2;
    const buf = atr * 0.35;

    // Invalidated if price closes above M2 after M3 formed
    const afterM3 = closed.filter((c) => c.openTime > m3.time);
    const invalidated = afterM3.some((c) => c.close > m2.price);

    seenTime.add(m3.time);
    patterns.push({
      direction: "bear",
      level: qmLevel,
      top: qmLevel + buf,
      bottom: qmLevel - buf,
      m1Price: m1.price,
      m2Price: m2.price,  // SL above here for shorts
      m3Price: m3.price,
      time: m3.time,
      timeframe: tf,
      invalidated,
    });
  }

  // ── Bullish QM: V1(low) → V2(lower low) → V3(higher low, ≈ V1) ─────────────
  // V3 is the LONG entry — market failed to break V2 and returns to V1 level
  const lows = swings.filter((s) => s.kind === "low");
  for (let i = 2; i < lows.length; i++) {
    const v1 = lows[i - 2];
    const v2 = lows[i - 1];
    const v3 = lows[i];
    if (!v1 || !v2 || !v3) continue;
    if (seenTime.has(v3.time)) continue;

    const isQM =
      v2.price < v1.price &&            // V2 is lower (the trough)
      v3.price > v2.price &&            // V3 fails to reach V2 (key criterion)
      v3.price < v1.price + atr &&      // V3 near V1 level
      v3.price > v1.price - atr * 2;

    if (!isQM) continue;

    const qmLevel = (v1.price + v3.price) / 2;
    const buf = atr * 0.35;

    const afterV3 = closed.filter((c) => c.openTime > v3.time);
    const invalidated = afterV3.some((c) => c.close < v2.price);

    seenTime.add(v3.time);
    patterns.push({
      direction: "bull",
      level: qmLevel,
      top: qmLevel + buf,
      bottom: qmLevel - buf,
      m1Price: v1.price,
      m2Price: v2.price,  // SL below here for longs
      m3Price: v3.price,
      time: v3.time,
      timeframe: tf,
      invalidated,
    });
  }

  return patterns.filter((p) => !p.invalidated);
}
