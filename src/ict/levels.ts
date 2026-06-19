import type { Candle } from "./types.ts";

export type PriceLevelKind = "PDH" | "PDL" | "PDO" | "PWH" | "PWL" | "PWO";

export interface PriceLevel {
  kind: PriceLevelKind;
  price: number;
  time: number;
}

export function calcPriceLevels(
  dailyCandles: readonly Candle[],
  weeklyCandles: readonly Candle[],
): PriceLevel[] {
  const levels: PriceLevel[] = [];
  const closedD = dailyCandles.filter((c) => c.closed);
  const prevDay = closedD.at(-1);
  if (prevDay) {
    levels.push({ kind: "PDH", price: prevDay.high, time: prevDay.openTime });
    levels.push({ kind: "PDL", price: prevDay.low,  time: prevDay.openTime });
    levels.push({ kind: "PDO", price: prevDay.open, time: prevDay.openTime });
  }
  const closedW = weeklyCandles.filter((c) => c.closed);
  const prevWeek = closedW.at(-1);
  if (prevWeek) {
    levels.push({ kind: "PWH", price: prevWeek.high, time: prevWeek.openTime });
    levels.push({ kind: "PWL", price: prevWeek.low,  time: prevWeek.openTime });
    levels.push({ kind: "PWO", price: prevWeek.open, time: prevWeek.openTime });
  }
  return levels;
}
