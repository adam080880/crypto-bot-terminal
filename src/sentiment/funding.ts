import type { FundingEntry, LongShortEntry } from "./types.ts";

// ── Binance ───────────────────────────────────────────────────────────────────

async function fetchBinanceFunding(symbol: string): Promise<FundingEntry | null> {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol.toUpperCase()}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    const d = (await res.json()) as { lastFundingRate: string; nextFundingTime: number };
    return {
      exchange: "BNC",
      rate: parseFloat(d.lastFundingRate),
      nextFundingTime: new Date(d.nextFundingTime),
    };
  } catch { return null; }
}

async function fetchBinanceLongShort(symbol: string): Promise<LongShortEntry | null> {
  try {
    const res = await fetch(
      `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol.toUpperCase()}&period=5m&limit=1`,
      { signal: AbortSignal.timeout(5_000) }
    );
    const d = (await res.json()) as Array<{ longShortRatio: string }>;
    if (!d[0]) return null;
    return { exchange: "BNC", ratio: parseFloat(d[0].longShortRatio) };
  } catch { return null; }
}

// ── Bybit ─────────────────────────────────────────────────────────────────────

async function fetchBybitFunding(symbol: string): Promise<FundingEntry | null> {
  try {
    const res = await fetch(
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol.toUpperCase()}&limit=1`,
      { signal: AbortSignal.timeout(5_000) }
    );
    const d = (await res.json()) as { result: { list: Array<{ fundingRate: string; fundingRateTimestamp: string }> } };
    const entry = d.result?.list[0];
    if (!entry) return null;
    return {
      exchange: "BYB",
      rate: parseFloat(entry.fundingRate),
      nextFundingTime: null,
    };
  } catch { return null; }
}

async function fetchBybitLongShort(symbol: string): Promise<LongShortEntry | null> {
  try {
    const res = await fetch(
      `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${symbol.toUpperCase()}&period=5min&limit=1`,
      { signal: AbortSignal.timeout(5_000) }
    );
    const d = (await res.json()) as { result: { list: Array<{ buyRatio: string; sellRatio: string }> } };
    const entry = d.result?.list[0];
    if (!entry) return null;
    const buy = parseFloat(entry.buyRatio);
    const sell = parseFloat(entry.sellRatio);
    return { exchange: "BYB", ratio: sell > 0 ? buy / sell : 1 };
  } catch { return null; }
}

// ── OKX ───────────────────────────────────────────────────────────────────────

async function fetchOkxFunding(symbol: string): Promise<FundingEntry | null> {
  try {
    const base = symbol.replace(/USDT$/i, "");
    const instId = `${base.toUpperCase()}-USDT-SWAP`;
    const res = await fetch(
      `https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    const d = (await res.json()) as { data: Array<{ fundingRate: string; nextFundingTime: string }> };
    const entry = d.data[0];
    if (!entry) return null;
    return {
      exchange: "OKX",
      rate: parseFloat(entry.fundingRate),
      nextFundingTime: new Date(parseInt(entry.nextFundingTime)),
    };
  } catch { return null; }
}

// ── FundingFetcher ────────────────────────────────────────────────────────────

export class FundingFetcher {
  private funding: FundingEntry[] = [];
  private longShort: LongShortEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private onUpdate: () => void;

  constructor(onUpdate: () => void) {
    this.onUpdate = onUpdate;
  }

  start(symbol: string) {
    this.fetch(symbol);
    this.timer = setInterval(() => this.fetch(symbol), 30_000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getFunding(): FundingEntry[] { return this.funding; }
  getLongShort(): LongShortEntry[] { return this.longShort; }

  private async fetch(symbol: string) {
    const [fBnc, fByb, fOkx, lsBnc, lsByb] = await Promise.allSettled([
      fetchBinanceFunding(symbol),
      fetchBybitFunding(symbol),
      fetchOkxFunding(symbol),
      fetchBinanceLongShort(symbol),
      fetchBybitLongShort(symbol),
    ]);

    this.funding = [fBnc, fByb, fOkx]
      .filter((r): r is PromiseFulfilledResult<FundingEntry | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v): v is FundingEntry => v !== null);

    this.longShort = [lsBnc, lsByb]
      .filter((r): r is PromiseFulfilledResult<LongShortEntry | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v): v is LongShortEntry => v !== null);

    this.onUpdate();
  }
}
