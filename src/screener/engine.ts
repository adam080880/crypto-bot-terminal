import { EventEmitter } from "events";
import type { Candle, Timeframe } from "../ict/types.ts";
import type { ScreenerResult, ScreenerSnapshot } from "./types.ts";
import { findOrderBlocks } from "../ict/orderBlock.ts";
import { findFVGs } from "../ict/fvg.ts";
import { findSwings, detectStructure } from "../ict/structure.ts";
import { calcPremiumDiscount } from "../ict/premiumDiscount.ts";
import { calcATR } from "../ict/atr.ts";
import { obToPOI, fvgToPOI, buildPOIStacks } from "../ict/poi.ts";
import { detectSetups } from "../ict/setupDetector.ts";
import { getKillZone } from "../ict/killzone.ts";
import { fetchTopSymbols, DEFAULT_SYMBOLS } from "./symbols.ts";

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 600;
const SCAN_INTERVAL_MS = 5 * 60_000;

type KlineRow = [number, string, string, string, string, string, number, ...unknown[]];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchKlines(symbol: string, interval: Timeframe, limit: number): Promise<Candle[]> {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${symbol}/${interval} HTTP ${res.status}`);
  const raw = (await res.json()) as KlineRow[];
  return raw.map((r): Candle => ({
    openTime: r[0],
    open:     parseFloat(r[1]),
    high:     parseFloat(r[2]),
    low:      parseFloat(r[3]),
    close:    parseFloat(r[4]),
    volume:   parseFloat(r[5]),
    closeTime: r[6],
    closed: true,
  }));
}

export declare interface ScreenerEngine {
  on(event: "update", listener: () => void): this;
  emit(event: "update"): boolean;
}

export class ScreenerEngine extends EventEmitter {
  private results: Map<string, ScreenerResult> = new Map();
  private scanning = false;
  private lastScanAt = 0;
  private scannedCount = 0;
  private totalSymbols = 0;
  private intervalId?: ReturnType<typeof setInterval>;

  start(): void {
    void this.runScan();
    this.intervalId = setInterval(() => { void this.runScan(); }, SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  get(): ScreenerSnapshot {
    return {
      results: [...this.results.values()],
      scanning: this.scanning,
      lastScanAt: this.lastScanAt,
      progress: { done: this.scannedCount, total: this.totalSymbols },
    };
  }

  private async runScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.scannedCount = 0;
    this.emit("update");

    let symbols: string[];
    try {
      symbols = await fetchTopSymbols(30);
    } catch {
      symbols = [...DEFAULT_SYMBOLS];
    }
    this.totalSymbols = symbols.length;

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      const outcomes = await Promise.allSettled(batch.map((s) => this.analyzeSymbol(s)));

      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") {
          this.results.set(outcome.value.symbol, outcome.value);
        }
        this.scannedCount++;
      }

      this.emit("update");
      if (i + BATCH_SIZE < symbols.length) await sleep(BATCH_DELAY_MS);
    }

    this.scanning = false;
    this.lastScanAt = Date.now();
    this.emit("update");
  }

  private async analyzeSymbol(symbol: string): Promise<ScreenerResult> {
    let c1d: Candle[], c4h: Candle[], c1h: Candle[], c15m: Candle[];
    try {
      [c1d, c4h, c1h, c15m] = await Promise.all([
        fetchKlines(symbol, "1d",  200),
        fetchKlines(symbol, "4h",  200),
        fetchKlines(symbol, "1h",  300),
        fetchKlines(symbol, "15m", 400),
      ]);
    } catch (err) {
      return { symbol, price: 0, htfTrend: "ranging", setups: [], scannedAt: Date.now(), error: String(err) };
    }

    const price = c15m.at(-1)?.close ?? c1h.at(-1)?.close ?? 0;
    if (!price) return { symbol, price: 0, htfTrend: "ranging", setups: [], scannedAt: Date.now() };

    const atr = calcATR(c15m) || calcATR(c1h) || calcATR(c4h);
    if (!atr) return { symbol, price, htfTrend: "ranging", setups: [], scannedAt: Date.now() };

    const htfSwings = findSwings(c1d, 2);
    const { trend: htfTrend } = detectStructure(c1d, htfSwings);
    if (htfTrend === "ranging") return { symbol, price, htfTrend, setups: [], scannedAt: Date.now() };

    const midSwings  = findSwings(c4h,  2);
    const entrySwings = findSwings(c15m, 2);

    // OBs for cascade (buildPOIStacks filters to OB-only internally)
    // FVGs from HTFs included so findTarget can use them as profit targets
    const allPOIs = [
      ...findOrderBlocks(c1d,  "1d" ).map(obToPOI),
      ...findFVGs(       c1d,  "1d" ).map(fvgToPOI),
      ...findOrderBlocks(c4h,  "4h" ).map(obToPOI),
      ...findFVGs(       c4h,  "4h" ).map(fvgToPOI),
      ...findOrderBlocks(c1h,  "1h" ).map(obToPOI),
      ...findOrderBlocks(c15m, "15m").map(obToPOI),
    ];

    const pd     = calcPremiumDiscount(htfSwings, price);
    const stacks = buildPOIStacks(allPOIs, price, atr, 20);

    const setups = detectSetups({
      symbol,
      entryCandles: c15m,
      htfTrend,
      swings:    entrySwings,
      htfSwings: [...midSwings, ...htfSwings],
      poiStacks: stacks,
      allPOIs,
      pd,
      killzone:       getKillZone(),
      structureEvents: [],
      price,
      atr,
    });

    return { symbol, price, htfTrend, setups, scannedAt: Date.now() };
  }
}
