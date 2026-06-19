import { EventEmitter } from "events";
import type { Candle, Timeframe } from "../ict/types.ts";
import type { ScreenerResult, ScreenerSnapshot } from "./types.ts";
import { findOrderBlocks } from "../ict/orderBlock.ts";
import { findFVGs, findIFVGs } from "../ict/fvg.ts";
import { findOCLs } from "../ict/ocl.ts";
import { findSRFlips } from "../ict/rbs.ts";
import { findQuasimodo } from "../ict/quasimodo.ts";
import { findSwings, detectStructure } from "../ict/structure.ts";
import { calcPremiumDiscount } from "../ict/premiumDiscount.ts";
import { calcATR } from "../ict/atr.ts";
import { obToPOI, fvgToPOI, ifvgToPOI, oclToPOI, srFlipToPOI, qmToPOI, buildPOIStacks, markFVGBacking } from "../ict/poi.ts";
import { detectSetups } from "../ict/setupDetector.ts";
import { getKillZone } from "../ict/killzone.ts";
import { fetchAllCryptoPerps, DEFAULT_SYMBOLS } from "./symbols.ts";
import { runBacktest } from "../ict/backtest.ts";

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1200; // 5 symbols × 4 klines × weight 2 = 40 weight/batch → ~2000 weight/min (safe under 2400 limit)
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
    closed: r[6] < Date.now(),
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

  /**
   * Returns the top N symbol names ranked by best setup confidence.
   * Used by BotPool to decide which symbols deserve a live ICT engine.
   */
  getTopCandidates(n: number): { symbol: string; rank: number }[] {
    return [...this.results.values()]
      .filter((r) => !r.error && r.htfTrend !== "ranging" && r.setups.length > 0)
      .sort((a, b) => {
        const ac = a.setups[0]?.confidence ?? 0;
        const bc = b.setups[0]?.confidence ?? 0;
        return bc - ac;
      })
      .slice(0, n)
      .map((r, i) => ({ symbol: r.symbol, rank: i + 1 }));
  }

  private async runScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.scannedCount = 0;
    this.emit("update");

    let symbols: string[];
    try {
      symbols = await fetchAllCryptoPerps();
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
        fetchKlines(symbol, "1d",  500),
        fetchKlines(symbol, "4h",  500),
        fetchKlines(symbol, "1h",  500),
        fetchKlines(symbol, "15m", 500),
      ]);
    } catch (err) {
      return { symbol, price: 0, htfTrend: "ranging", setups: [], scannedAt: Date.now(), error: String(err) };
    }

    const price = c15m.at(-1)?.close ?? c1h.at(-1)?.close ?? 0;
    if (!price) return { symbol, price: 0, htfTrend: "ranging", setups: [], scannedAt: Date.now() };

    const atr = calcATR(c15m) || calcATR(c1h) || calcATR(c4h);
    if (!atr) return { symbol, price, htfTrend: "ranging", setups: [], scannedAt: Date.now() };

    const htfSwings = findSwings(c1d, 2);
    const { trend: htfTrend, events: htfEvents } = detectStructure(c1d, htfSwings);
    // NOTE: ranging symbols are NO LONGER skipped — they still produce setups
    // (scored lower in detectSetups). This widens coverage for range-bound POIs.

    const midSwings  = findSwings(c4h,  2);
    const entrySwings = findSwings(c15m, 2);
    const { events: midEvents }   = detectStructure(c4h,  midSwings);
    const { events: entryEvents } = detectStructure(c15m, entrySwings);

    // Valid entry POIs (OB, iFVG, RBS, SBR, OCL, QM) across all TFs.
    // Plain FVG is included only as supporting/target data (excluded from cascade
    // inside buildPOIStacks); used for FVG-backing flags + profit-target finding.
    const allPOIs = [
      // ── macro: 1d ──
      ...findOrderBlocks(c1d,  "1d" ).map(obToPOI),
      ...findIFVGs(      c1d,  "1d" ).map(ifvgToPOI),
      ...findOCLs(       c1d,  "1d" ).map(oclToPOI),
      ...findSRFlips(    c1d,  "1d" ).map(srFlipToPOI),
      ...findQuasimodo(  c1d,  "1d" ).map(qmToPOI),
      ...findFVGs(       c1d,  "1d" ).map(fvgToPOI),
      // ── intermediate: 4h / 1h ──
      ...findOrderBlocks(c4h,  "4h" ).map(obToPOI),
      ...findIFVGs(      c4h,  "4h" ).map(ifvgToPOI),
      ...findOCLs(       c4h,  "4h" ).map(oclToPOI),
      ...findSRFlips(    c4h,  "4h" ).map(srFlipToPOI),
      ...findQuasimodo(  c4h,  "4h" ).map(qmToPOI),
      ...findFVGs(       c4h,  "4h" ).map(fvgToPOI),
      ...findOrderBlocks(c1h,  "1h" ).map(obToPOI),
      ...findIFVGs(      c1h,  "1h" ).map(ifvgToPOI),
      ...findOCLs(       c1h,  "1h" ).map(oclToPOI),
      ...findSRFlips(    c1h,  "1h" ).map(srFlipToPOI),
      ...findQuasimodo(  c1h,  "1h" ).map(qmToPOI),
      ...findFVGs(       c1h,  "1h" ).map(fvgToPOI),
      // ── entry: 15m ──
      ...findOrderBlocks(c15m, "15m").map(obToPOI),
      ...findIFVGs(      c15m, "15m").map(ifvgToPOI),
      ...findOCLs(       c15m, "15m").map(oclToPOI),
      ...findQuasimodo(  c15m, "15m").map(qmToPOI),
      ...findFVGs(       c15m, "15m").map(fvgToPOI),
    ];

    // Flag entry POIs that sit near a same-TF FVG (higher probability per Materi 2)
    markFVGBacking(allPOIs, atr);

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
      structureEvents: [...htfEvents, ...midEvents, ...entryEvents],
      price,
      atr,
    });

    const candleMap = new Map<Timeframe, Candle[]>([
      ["1d",  c1d],
      ["4h",  c4h],
      ["1h",  c1h],
      ["15m", c15m],
    ]);
    const btResult = runBacktest(candleMap, symbol);

    return {
      symbol, price, htfTrend, setups, scannedAt: Date.now(),
      backtestGrade:   btResult?.grade,
      backtestWinRate: btResult?.winRate,
      backtestTrades:  btResult?.totalTrades,
    };
  }
}
