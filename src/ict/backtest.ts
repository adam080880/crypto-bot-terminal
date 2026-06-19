import type { Candle, Direction, Timeframe, SetupType, TradeCategory, POI } from "./types.ts";
import { findSwings, detectStructure } from "./structure.ts";
import { findOrderBlocks } from "./orderBlock.ts";
import { findFVGs, findIFVGs } from "./fvg.ts";
import { findOCLs } from "./ocl.ts";
import { findSRFlips } from "./rbs.ts";
import { findQuasimodo } from "./quasimodo.ts";
import {
  obToPOI, fvgToPOI, ifvgToPOI, oclToPOI, srFlipToPOI, qmToPOI,
  detectPOIResponse, buildPOIStacks, markFVGBacking,
} from "./poi.ts";
import { calcPremiumDiscount } from "./premiumDiscount.ts";
import { getKillZone } from "./killzone.ts";
import { calcATR } from "./atr.ts";
import { detectSetups } from "./setupDetector.ts";
import type { ICTSetup } from "./types.ts";

export type BacktestGrade = "S" | "A" | "B" | "C" | "D";

export interface SetupStats {
  trades: number;
  wins: number;
  winRate: number;
  avgRR: number;
  netPnlR: number;
}

export interface BacktestTrade {
  type: SetupType;
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  confidence: number;
  outcome: "win" | "loss";
  pnlR: number;
  tradeCategory?: TradeCategory;
}

export interface BacktestResult {
  symbol: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnlR: number;
  maxDrawdownR: number;
  bestWinStreak: number;
  worstLossStreak: number;
  avgWinRR: number;
  avgConfidence: number;
  grade: BacktestGrade;
  rankLabel: string;
  testedAt: number;
  candlesAnalyzed: number;
  byType: Partial<Record<SetupType, SetupStats>>;
  byCategory: Partial<Record<TradeCategory, SetupStats>>;
}

const BASE_TF: Timeframe = "15m";
const LOOKFORWARD = 80;  // 15m candles to check for outcome (~20h)
const STEP = 40;         // run analysis every 40 candles
const MIN_WARMUP = 80;   // candles needed before first analysis

const RANK_LABELS: Record<BacktestGrade, string> = {
  S: "LEGENDARY",
  A: "MASTER",
  B: "EXPERT",
  C: "NOVICE",
  D: "UNRANKED",
};

export function runBacktest(
  candlesByTF: Map<Timeframe, Candle[]>,
  symbol: string,
): BacktestResult | null {
  const base = candlesByTF.get(BASE_TF) ?? [];
  if (base.length < MIN_WARMUP + LOOKFORWARD + STEP) return null;

  const trades: BacktestTrade[] = [];
  const seenSetupIds = new Set<string>();

  for (let i = MIN_WARMUP; i < base.length - LOOKFORWARD; i += STEP) {
    const currentTime = base[i]!.openTime;

    const sliced = new Map<Timeframe, Candle[]>();
    for (const [tf, candles] of candlesByTF) {
      sliced.set(tf, candles.filter((c) => c.openTime <= currentTime));
    }

    const setups = analyzeSlice(sliced, symbol);
    const futureCandles = base.slice(i + 1, i + 1 + LOOKFORWARD);

    for (const setup of setups) {
      if (seenSetupIds.has(setup.id)) continue;
      seenSetupIds.add(setup.id);
      if (setup.confidence < 50) continue;

      const outcome = checkOutcome(setup, futureCandles);
      if (outcome === "open") continue;

      trades.push({
        type: setup.type,
        direction: setup.direction,
        entry: setup.entry,
        stop: setup.stop,
        target: setup.target,
        rr: setup.rr,
        confidence: setup.confidence,
        outcome,
        pnlR: outcome === "win" ? setup.rr : -1,
        tradeCategory: setup.tradeCategory,
      });
    }
  }

  return buildResult(trades, symbol, base.length);
}

function checkOutcome(setup: ICTSetup, future: Candle[]): "win" | "loss" | "open" {
  for (const c of future) {
    if (setup.direction === "bull") {
      if (c.low <= setup.stop) return "loss";
      if (c.high >= setup.target) return "win";
    } else {
      if (c.high >= setup.stop) return "loss";
      if (c.low <= setup.target) return "win";
    }
  }
  return "open";
}

function computePOIs(candles: Candle[], tf: Timeframe): POI[] {
  const obs     = findOrderBlocks(candles, tf);
  const fvgs    = findFVGs(candles, tf);
  const ifvgs   = findIFVGs(candles, tf);
  const ocls    = findOCLs(candles, tf);
  const srFlips = findSRFlips(candles, tf);
  const qms     = ["1m", "5m", "15m", "1h", "4h"].includes(tf)
    ? findQuasimodo(candles, tf) : [];
  return [
    ...obs.map(obToPOI),
    ...fvgs.map(fvgToPOI),
    ...ifvgs.map(ifvgToPOI),
    ...ocls.map(oclToPOI),
    ...srFlips.map(srFlipToPOI),
    ...qms.map(qmToPOI),
  ];
}

function analyzeSlice(candlesByTF: Map<Timeframe, Candle[]>, symbol: string): ICTSetup[] {
  const entryC = candlesByTF.get("15m") ?? [];
  const htfC   = candlesByTF.get("1d")  ?? [];
  const midC   = candlesByTF.get("4h")  ?? [];
  const ltfC   = candlesByTF.get("1m")  ?? entryC;

  if (entryC.length < 20 || htfC.length < 5) return [];
  const price = entryC.at(-1)?.close ?? 0;
  if (price === 0) return [];

  const atr = calcATR(entryC.filter((c) => c.closed));
  if (atr === 0) return [];

  const allPOIs: POI[] = [];
  for (const [tf, candles] of candlesByTF) {
    if (candles.length < 5) continue;
    const raw = computePOIs(candles, tf);
    const buf = atr * 0.15;
    const updated = raw.map((p): POI => {
      const inZone = price >= p.bottom - buf && price <= p.top + buf;
      // Backdate touchedAt so detectPOIResponse's 60s confirmation check passes
      const touchedAt = inZone ? Date.now() - 120_000 : null;
      const response = detectPOIResponse({ ...p, touchedAt }, ltfC, price, atr);
      return { ...p, response, touchedAt };
    });
    allPOIs.push(...updated);
  }

  markFVGBacking(allPOIs, atr);

  const htfSwings = findSwings(htfC, 2);
  const { trend: htfTrend } = detectStructure(htfC, htfSwings);

  const midSwings = findSwings(midC, 2);
  const { events: midEvents } = detectStructure(midC, midSwings);

  const entrySwings = findSwings(entryC, 2);
  const { events: entryEvents } = detectStructure(entryC, entrySwings);

  const allEvents = [...midEvents, ...entryEvents]
    .sort((a, b) => b.time - a.time)
    .slice(0, 8);

  const pd       = calcPremiumDiscount(htfSwings, price);
  const killzone = getKillZone(new Date(entryC.at(-1)?.closeTime ?? Date.now()));
  const stacks   = buildPOIStacks(allPOIs, price, atr, 20);

  return detectSetups({
    symbol,
    entryCandles: entryC,
    htfTrend,
    swings: entrySwings,
    htfSwings: [...midSwings, ...htfSwings],
    poiStacks: stacks,
    allPOIs,
    pd,
    killzone,
    structureEvents: allEvents,
    price,
    atr,
  });
}

function buildResult(
  trades: BacktestTrade[],
  symbol: string,
  candlesAnalyzed: number,
): BacktestResult {
  if (trades.length === 0) {
    return {
      symbol, totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      netPnlR: 0, maxDrawdownR: 0, bestWinStreak: 0, worstLossStreak: 0,
      avgWinRR: 0, avgConfidence: 0, grade: "D", rankLabel: RANK_LABELS.D,
      testedAt: Date.now(), candlesAnalyzed,
      byType: {}, byCategory: {},
    };
  }

  const wins   = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.length - wins;
  const winRate = wins / trades.length;
  const netPnlR = trades.reduce((s, t) => s + t.pnlR, 0);
  const avgWinRR = wins > 0
    ? trades.filter((t) => t.outcome === "win").reduce((s, t) => s + t.rr, 0) / wins
    : 0;
  const avgConfidence = trades.reduce((s, t) => s + t.confidence, 0) / trades.length;

  let bestWinStreak = 0, worstLossStreak = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (t.outcome === "win") { curW++; curL = 0; bestWinStreak = Math.max(bestWinStreak, curW); }
    else                     { curL++; curW = 0; worstLossStreak = Math.max(worstLossStreak, curL); }
  }

  let peak = 0, equity = 0, maxDrawdownR = 0;
  for (const t of trades) {
    equity += t.pnlR;
    if (equity > peak) peak = equity;
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  let grade: BacktestGrade = "D";
  if      (winRate >= 0.60 && avgWinRR >= 2.0 && netPnlR >= 5) grade = "S";
  else if (winRate >= 0.55 && avgWinRR >= 1.8)                  grade = "A";
  else if (winRate >= 0.50 && avgWinRR >= 1.5)                  grade = "B";
  else if (winRate >= 0.45 && avgWinRR >= 1.2)                  grade = "C";

  const byType: Partial<Record<SetupType, SetupStats>> = {};
  for (const t of ["CB1", "CB2", "CR"] as SetupType[]) {
    const sub = trades.filter((x) => x.type === t);
    if (!sub.length) continue;
    const w = sub.filter((x) => x.outcome === "win").length;
    byType[t] = {
      trades: sub.length, wins: w, winRate: w / sub.length,
      avgRR: w ? sub.filter((x) => x.outcome === "win").reduce((s, x) => s + x.rr, 0) / w : 0,
      netPnlR: sub.reduce((s, x) => s + x.pnlR, 0),
    };
  }

  const byCategory: Partial<Record<TradeCategory, SetupStats>> = {};
  for (const c of ["swing", "intraday", "scalp"] as TradeCategory[]) {
    const sub = trades.filter((x) => x.tradeCategory === c);
    if (!sub.length) continue;
    const w = sub.filter((x) => x.outcome === "win").length;
    byCategory[c] = {
      trades: sub.length, wins: w, winRate: w / sub.length,
      avgRR: w ? sub.filter((x) => x.outcome === "win").reduce((s, x) => s + x.rr, 0) / w : 0,
      netPnlR: sub.reduce((s, x) => s + x.pnlR, 0),
    };
  }

  return {
    symbol, totalTrades: trades.length, wins, losses, winRate,
    netPnlR, maxDrawdownR, bestWinStreak, worstLossStreak,
    avgWinRR, avgConfidence, grade, rankLabel: RANK_LABELS[grade],
    testedAt: Date.now(), candlesAnalyzed,
    byType, byCategory,
  };
}
