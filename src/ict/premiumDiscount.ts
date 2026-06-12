import type { SwingPoint, PremiumDiscount } from "./types.ts";

export function calcPremiumDiscount(swings: SwingPoint[], price: number): PremiumDiscount {
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");

  const rangeHigh = highs.at(-1)?.price ?? price * 1.02;
  const rangeLow = lows.at(-1)?.price ?? price * 0.98;
  const equilibrium = (rangeHigh + rangeLow) / 2;

  const range = rangeHigh - rangeLow;
  const pct = range > 0 ? Math.max(0, Math.min(1, (price - rangeLow) / range)) : 0.5;

  const zone: PremiumDiscount["zone"] =
    pct > 0.55 ? "premium" :
    pct < 0.45 ? "discount" :
    "equilibrium";

  return { rangeHigh, rangeLow, equilibrium, current: price, zone, pct };
}
