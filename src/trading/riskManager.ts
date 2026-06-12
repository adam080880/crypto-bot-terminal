export interface SizingParams {
  balance: number;
  riskPct: number;
  entryPrice: number;
  stopPrice: number;
  leverage: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export function calcQty(p: SizingParams): number {
  const stopDist = Math.abs(p.entryPrice - p.stopPrice);
  if (stopDist === 0) return p.minQty;

  // Dollar risk per unit = stopDist; total risk budget = balance * riskPct
  const dollarRisk = p.balance * p.riskPct;
  const rawQty = dollarRisk / stopDist;

  // Round down to stepSize precision
  const stepped = Math.floor(rawQty / p.stepSize) * p.stepSize;
  const qty = Math.max(stepped, p.minQty);

  // Ensure minimum notional (qty * entryPrice >= minNotional / leverage factor is ignored for futures sizing)
  const notional = qty * p.entryPrice;
  if (notional < p.minNotional) {
    const minQtyForNotional = Math.ceil(p.minNotional / p.entryPrice / p.stepSize) * p.stepSize;
    return Math.max(qty, minQtyForNotional);
  }

  return qty;
}
