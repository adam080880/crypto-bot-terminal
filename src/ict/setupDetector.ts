import type {
  Candle, POI, POIStack, SwingPoint, StructureEvent,
  PremiumDiscount, KillZoneStatus, ICTSetup, Direction,
  Trend, SetupType, Timeframe, TradeCategory, LiquidityGrade, PriceLevel,
} from "./types.ts";
import { isEntryPOIKind } from "./poi.ts";

export interface DetectContext {
  symbol: string;
  entryCandles: readonly Candle[];
  htfTrend: Trend;
  swings: SwingPoint[];
  htfSwings: SwingPoint[];
  poiStacks: POIStack[];
  allPOIs: readonly POI[];
  pd: PremiumDiscount;
  killzone: KillZoneStatus;
  structureEvents: StructureEvent[];
  price: number;
  atr: number;
  priceLevels?: readonly PriceLevel[];
}

export function detectSetups(ctx: DetectContext): ICTSetup[] {
  if (ctx.atr === 0) return [];

  // HTF trend gives a preferred direction, but ranging is no longer an early-out —
  // ranging symbols still produce setups, just scored lower (handled in score()).
  const trendDir: Direction | null =
    ctx.htfTrend === "bullish" ? "bull" : ctx.htfTrend === "bearish" ? "bear" : null;

  const setups: ICTSetup[] = [];

  for (const stack of ctx.poiStacks) {
    const direction = stack.direction;

    // When we have a clear HTF trend, only take stacks aligned with it.
    if (trendDir !== null && direction !== trendDir) continue;

    // Determine if price is actively at the zone or just approaching
    const atZone = ctx.price >= stack.overlapBottom - ctx.atr && ctx.price <= stack.overlapTop + ctx.atr;
    const setupStatus = atZone ? "active" : "watching";

    // ── POI hit → valid POI detection (PRIMARY entry signal) ───────────────
    // Materi 3: mark HTF POI → wait for it to be HIT → a fresh LTF "OB Valid"
    // forms inside the zone → entry goes there, NOT at the original HTF POI.
    const validPOI = findValidPOI(stack);

    // ── MSS-zone entry ─────────────────────────────────────────────────────
    // Materi 1: after a CHoCH/BOS, don't entry immediately — wait for a POI to
    // form in the broken-level zone (below for bull, above for bear). If a fresh
    // entry POI sits in that zone, it overrides as the execution level.
    const mssPOI = validPOI ? undefined : findMSSEntry(stack, direction, ctx);

    // Precision entry: valid LTF POI > MSS-zone POI > full overlap midpoint
    const execPOI = validPOI ?? mssPOI;
    const entryTop    = execPOI ? execPOI.top    : stack.overlapTop;
    const entryBottom = execPOI ? execPOI.bottom : stack.overlapBottom;
    const entry = (entryTop + entryBottom) / 2;

    // Actual execution price: limit goes at zone edge, not midpoint.
    // All SL distance checks and risk/RR calculations use this, not `entry`,
    // so the numbers reflect what happens at fill time.
    const execEntry = direction === "bull" ? entryBottom : entryTop;

    // SL priority: OB wick stop → QM M2 extreme → valid POI OB stop → ATR fallback
    const slPOI = execPOI ?? stack.entryPOI;
    const obWickStop  = slPOI.kind === "OB" ? slPOI.wickStop  : undefined;
    const qmStop      = slPOI.kind === "QM" ? slPOI.m2Price   : undefined;
    let stop = obWickStop !== undefined
      ? obWickStop
      : qmStop !== undefined
        ? qmStop
        : direction === "bull"
          ? entryBottom - ctx.atr * 1.5
          : entryTop + ctx.atr * 1.5;

    // Enforce minimum SL distance measured from the ACTUAL EXECUTION PRICE (execEntry),
    // not the zone midpoint. Minimum = max(1.5% of price, 1.5× ATR) so the stop
    // survives normal crypto noise and high-leverage wicks.
    const minSlDist = Math.max(execEntry * 0.015, ctx.atr * 1.5);
    if (Math.abs(execEntry - stop) < minSlDist) {
      if (direction === "bull") {
        const nearest = ctx.swings
          .filter((s) => s.kind === "low" && s.price < execEntry - minSlDist)
          .sort((a, b) => b.price - a.price)
          .at(0);
        stop = nearest ? nearest.price * 0.999 : execEntry - minSlDist;
      } else {
        const nearest = ctx.swings
          .filter((s) => s.kind === "high" && s.price > execEntry + minSlDist)
          .sort((a, b) => a.price - b.price)
          .at(0);
        stop = nearest ? nearest.price * 1.001 : execEntry + minSlDist;
      }
    }

    const risk = Math.abs(execEntry - stop);
    if (risk <= 0) continue;

    const target = findTarget(direction, ctx.price, ctx.allPOIs, ctx.htfSwings, ctx.atr, execEntry, stop, ctx.priceLevels);
    if (target === null) continue;

    const rr = Math.abs(target - execEntry) / risk;

    const setupType = classifySetup(stack, ctx, validPOI, mssPOI);
    const { confidence, reasons } = score({ stack, ctx, rr, atZone, validPOI, mssPOI, execPOI, target, priceLevels: ctx.priceLevels });
    // Watching setups use a lower confidence threshold
    if (atZone && confidence < 50) continue;
    if (!atZone && confidence < 40) continue;

    const tradeCategory = classifyTradeCategory(stack, setupType, entry, target, ctx);
    // Drop setups that don't meet the per-category minimum R:R
    if (rr < MIN_RR_BY_CATEGORY[tradeCategory]) continue;
    const liq = scoreLiquidity({ direction, entry, target, stack, ctx });

    setups.push({
      id: `${setupType}-${stack.id}`,
      type: setupType,
      direction,
      timeframe: (execPOI ?? stack.entryPOI).timeframe,
      entry,
      zoneTop: entryTop,
      zoneBottom: entryBottom,
      stop,
      target,
      rr,
      confidence,
      reasons,
      killzone: ctx.killzone.active,
      createdAt: Date.now(),
      status: setupStatus,
      poiStack: stack,
      tradeCategory,
      liquidityScore: liq.score,
      liquidityGrade: liq.grade,
      liquidityReasons: liq.reasons,
    });
  }

  return setups.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Detects the "HTF POI hit → LTF valid POI forms" concept:
 * When a macro/intermediate POI has been touched (touchedAt set), look for any
 * entry-group POI in the same stack that formed AFTER the hit.
 * That LTF POI is the "valid entry" — a precise OB/FVG created by smart money
 * after price reacted to the HTF level.
 */
function findValidPOI(stack: POIStack): POI | undefined {
  // Find the highest-ranking HTF layer that was touched
  const hitHTF = stack.layers
    .filter((l) => l.group !== "entry" && l.touchedAt !== null && l.touchedAt > 0)
    .sort((a, b) => {
      // Prefer macro > intermediate (higher TF = more authoritative)
      const rank: Record<string, number> = { macro: 2, intermediate: 1, entry: 0 };
      return (rank[b.group] ?? 0) - (rank[a.group] ?? 0);
    })
    .at(0);

  if (!hitHTF?.touchedAt) return undefined;

  // The valid LTF POI must:
  //   · be an entry-group POI of a valid entry kind (FVG excluded — supporting only)
  //   · have formed at or after the HTF was touched (5m timing buffer)
  const buf = 5 * 60_000;
  const validEntry = stack.layers.find(
    (l) =>
      l.group === "entry" &&
      isEntryPOIKind(l.kind) &&
      l.time >= hitHTF.touchedAt! - buf,
  );
  return validEntry;
}

/**
 * MSS-zone entry (Materi 1): after a CHoCH/BOS in `direction`, the broken level
 * defines a re-entry zone — below the level for bull, above for bear. A fresh
 * entry-group POI sitting inside that zone (within ~2× ATR of the broken level)
 * is the post-MSS execution POI. We don't entry at the MSS itself; we wait for
 * this POI to form.
 */
function findMSSEntry(stack: POIStack, direction: Direction, ctx: DetectContext): POI | undefined {
  const mss = ctx.structureEvents
    .filter((e) => e.direction === direction)
    .sort((a, b) => b.time - a.time)
    .at(0);
  if (!mss) return undefined;

  const band = ctx.atr * 2;
  // bull: POI should sit at/below the broken level (retrace into demand)
  // bear: POI should sit at/above the broken level (retrace into supply)
  const candidate = stack.layers
    .filter(
      (l) =>
        l.group === "entry" &&
        isEntryPOIKind(l.kind) &&
        l.time >= mss.time - 5 * 60_000 &&
        (direction === "bull"
          ? l.mid <= mss.level + ctx.atr * 0.25 && l.mid >= mss.level - band
          : l.mid >= mss.level - ctx.atr * 0.25 && l.mid <= mss.level + band),
    )
    .sort((a, b) => b.time - a.time)
    .at(0);
  return candidate;
}

/**
 * Setup classification (new rules):
 *   CR  = MSS (CHoCH/BOS) confirmed AND a POI formed in the new-direction zone.
 *   CB2 = HTF POI was hit and an LTF "OB Valid" formed inside → ready to entry.
 *   CB1 = HTF POI exists and price is approaching, but no hit / valid POI yet.
 */
function classifySetup(
  stack: POIStack,
  ctx: DetectContext,
  validPOI: POI | undefined,
  mssPOI: POI | undefined,
): SetupType {
  const recentStructure = ctx.structureEvents.some(
    (e) => e.direction === stack.direction &&
      Math.abs(e.time - stack.entryPOI.time) < 60_000 * 120,
  );

  // CR: a structural shift (CHoCH/BOS) plus a POI in the broken zone, or strong
  // multi-layer reaction confirming a continuation/reversal off the level.
  if (mssPOI) return "CR";
  if (stack.reactingLayers >= 2) return "CR";
  if (stack.reactingLayers >= 1 && recentStructure) return "CR";

  // CB2: HTF POI hit → valid LTF OB formed (the highest-confidence "ready" state).
  if (validPOI) return "CB2";
  if (stack.entryPOI.response === "reacting") return "CB2";

  // CB2 fallback: rejection wick on last closed candle inside the ENTRY POI zone.
  // Use entryPOI.top/bottom (the actual 15m/5m/1m zone), not the full cascade
  // intersection — extra HTF layers (1w, 1M) can shrink overlapTop/Bottom to
  // a tiny sliver that the wick never reaches, masking a valid CB2 signal.
  const closed = ctx.entryCandles.filter((c) => c.closed);
  const lastClosed = closed.at(-1);
  if (lastClosed) {
    const inZone = lastClosed.low <= stack.entryPOI.top && lastClosed.high >= stack.entryPOI.bottom;
    if (inZone) {
      const range = lastClosed.high - lastClosed.low;
      if (range > 0) {
        if (stack.direction === "bull") {
          const lowerWick = Math.min(lastClosed.open, lastClosed.close) - lastClosed.low;
          if (lowerWick > range * 0.45) return "CB2";
        } else {
          const upperWick = lastClosed.high - Math.max(lastClosed.open, lastClosed.close);
          if (upperWick > range * 0.45) return "CB2";
        }
      }
    }
  }

  // CB1: HTF POI present, price approaching, no hit/valid POI yet → watching.
  return "CB1";
}

// Minimum R:R that a target POI must satisfy relative to entry.
// Ensures findTarget never returns a level that gives RR < this floor.
const MIN_TARGET_RR = 1.5;

// Per-category minimum RR — setups below these are dropped at the detector level.
const MIN_RR_BY_CATEGORY: Record<TradeCategory, number> = {
  swing:    4.0,
  intraday: 2.0,
  scalp:    1.5,
};

function findTarget(
  direction: Direction,
  price: number,
  allPOIs: readonly POI[],
  htfSwings: SwingPoint[],
  atr: number,
  entry: number,
  stop: number,
  priceLevels?: readonly PriceLevel[],
): number | null {
  const oppDir: Direction = direction === "bull" ? "bear" : "bull";
  const risk = Math.abs(entry - stop);
  // Target must be at least MIN_TARGET_RR × risk from entry, and above/below current price
  const minDist = risk * MIN_TARGET_RR;
  const minTarget = direction === "bull"
    ? Math.max(price, entry + minDist)
    : Math.min(price, entry - minDist);

  // Prefer opposing unconsumed macro/intermediate POI as target
  const opposing = allPOIs
    .filter((p) => !p.consumed && p.direction === oppDir && p.group !== "entry")
    .filter((p) => direction === "bull" ? p.bottom > minTarget : p.top < minTarget)
    .sort((a, b) => direction === "bull" ? a.bottom - b.bottom : b.top - a.top);

  // Price level candidates: PDH/PWH for bull BSL, PDL/PWL for bear SSL
  const levelCandidates = (priceLevels ?? [])
    .filter((l) =>
      direction === "bull"
        ? (l.kind === "PDH" || l.kind === "PWH") && l.price > minTarget
        : (l.kind === "PDL" || l.kind === "PWL") && l.price < minTarget,
    )
    .sort((a, b) => direction === "bull" ? a.price - b.price : b.price - a.price);

  const allCandidatePrices: number[] = [];
  const poi = opposing.at(0);
  if (poi) allCandidatePrices.push(direction === "bull" ? poi.bottom : poi.top);
  const lvl = levelCandidates.at(0);
  if (lvl) allCandidatePrices.push(lvl.price);

  if (allCandidatePrices.length > 0) {
    return direction === "bull"
      ? Math.min(...allCandidatePrices)
      : Math.max(...allCandidatePrices);
  }

  // Fallback: HTF swing that also satisfies the minimum distance
  if (direction === "bull") {
    const candidates = htfSwings
      .filter((s) => s.kind === "high" && s.price > minTarget)
      .sort((a, b) => a.price - b.price);
    return candidates.at(0)?.price ?? null;
  }
  const candidates = htfSwings
    .filter((s) => s.kind === "low" && s.price < minTarget)
    .sort((a, b) => b.price - a.price);
  return candidates.at(0)?.price ?? null;
}

function fmtZ(n: number): string {
  if (n >= 10_000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(2);
}

function score(input: {
  stack: POIStack;
  ctx: DetectContext;
  rr: number;
  atZone: boolean;
  validPOI?: POI;
  mssPOI?: POI;
  execPOI?: POI;
  target?: number;
  priceLevels?: readonly PriceLevel[];
}): { confidence: number; reasons: string[] } {
  const { stack, ctx, rr, atZone, validPOI, mssPOI, execPOI, target, priceLevels } = input;
  const dir = stack.direction;
  let pts = 0;
  const reasons: string[] = [];

  // HTF alignment: full credit when trend matches; ranging gets partial credit.
  if (ctx.htfTrend === "ranging") { pts += 8; reasons.push("ranging HTF"); }
  else { pts += 20; reasons.push("HTF aligned"); }

  const correctZone = dir === "bull" ? ctx.pd.zone !== "premium" : ctx.pd.zone !== "discount";
  if (correctZone) { pts += 10; reasons.push(ctx.pd.zone); }
  else { pts -= 8; reasons.push(`vs ${ctx.pd.zone}`); } // counter-zone entry — penalize

  // HTF context: describe what's at each layer of the cascade
  const anchorTF = stack.anchorPOI.timeframe;
  const anchorKind = stack.anchorPOI.kind;
  reasons.push(`${anchorTF} ${anchorKind} ${fmtZ(stack.anchorPOI.bottom)}–${fmtZ(stack.anchorPOI.top)}`);

  if (stack.depth >= 2) {
    const mid = stack.layers.at(1);
    if (mid && mid.id !== stack.entryPOI.id) {
      reasons.push(`${mid.timeframe} ${mid.kind} ${fmtZ(mid.bottom)}–${fmtZ(mid.top)}`);
    }
  }

  // Depth bonus: each extra layer beyond 1 adds 8 pts, cap 24
  const depthBonus = Math.min((stack.depth - 1) * 8, 24);
  if (depthBonus > 0) { pts += depthBonus; reasons.push(`${stack.depth}× nest`); }

  // Group coverage bonus
  if (stack.groupsCovered.length === 3) { pts += 10; reasons.push("full cascade"); }
  else if (stack.groupsCovered.length === 2) { pts += 5; reasons.push("2-tier"); }

  // Response bonus: each reacting layer adds 6 pts, cap 18
  const respBonus = Math.min(stack.reactingLayers * 6, 18);
  if (respBonus > 0) { pts += respBonus; reasons.push(`${stack.reactingLayers} react`); }

  if (stack.anchorPOI.kind === "OB") { pts += 5; }

  // ── QM bonus (LTF confirmation — most powerful signal) ─────────────────
  const qmLayer = stack.layers.find((l) => l.kind === "QM");
  if (qmLayer) {
    pts += 15; reasons.push("QM confirm");

    // Combo: QM at LTF + HTF OB/RBS/SBR = premium setup
    const hasHTFContext = stack.layers.some(
      (l) => l.id !== qmLayer.id && (l.kind === "OB" || l.kind === "RBS" || l.kind === "SBR")
    );
    if (hasHTFContext) { pts += 10; reasons.push("QM+HTF combo"); }
  }
  if (stack.entryPOI.kind === "QM") { pts += 5; reasons.push("QM entry"); }

  // ── RBS / SBR bonuses ──────────────────────────────────────────────────
  const srLayer = stack.layers.find((l) => l.kind === "RBS" || l.kind === "SBR");
  if (srLayer) {
    const label = srLayer.kind;
    const touches = srLayer.touchCount ?? 1;
    pts += 12; reasons.push(label);
    // More tests before breaking = stronger flip level
    if (touches >= 3) { pts += 6; reasons.push(`${label} x${touches} tests`); }
    else if (touches >= 2) { pts += 3; reasons.push(`${label} x${touches} tests`); }

    // Extra bonus when the RBS/SBR is FVG-backed (probability increases per Materi 2)
    if (srLayer.hasFVG) { pts += 8; reasons.push(`${label}+FVG combo`); }
  }

  // HTF RBS/SBR anchor gets an extra bump (macro S/R flip = strong bias)
  if (stack.anchorPOI.kind === "RBS" || stack.anchorPOI.kind === "SBR") {
    pts += 8; reasons.push(`HTF ${stack.anchorPOI.kind}`);
  }

  if (ctx.structureEvents.some((e) => e.type === "BOS" && e.direction === dir)) {
    pts += 8; reasons.push("BOS");
  }
  if (ctx.structureEvents.some((e) => e.type === "CHoCH" && e.direction === dir)) {
    pts += 8; reasons.push("CHoCH");
  }

  // ── POI hit → valid POI (highest-probability entry pattern) ───────────────
  // Materi 3: HTF POI hit → new LTF "OB Valid" formed inside → price reacts off
  // that fresh structure rather than a stale zone. This is the core confirmation.
  if (validPOI) {
    pts += 18; reasons.push("POI→valid OB");
    if (validPOI.kind === "OB") { pts += 5; reasons.push("valid OB entry"); }
  }

  // ── MSS-zone entry (Materi 1) — POI formed in broken-structure zone ───────
  if (mssPOI) {
    pts += 16; reasons.push("MSS→POI entry");
    if (mssPOI.kind === "OB") { pts += 4; reasons.push("MSS OB"); }
  }

  // ── iFVG / OCL entry-kind notes ───────────────────────────────────────────
  if (execPOI?.kind === "iFVG") { pts += 6; reasons.push("iFVG entry"); }
  if (execPOI?.kind === "OCL")  { pts += 5; reasons.push("OCL entry"); }
  if (stack.layers.some((l) => l.kind === "iFVG")) reasons.push("iFVG layer");

  // ── FVG-backing bonus (Materi 2: OB/RBS/SBR/OCL/iFVG backed by an FVG) ─────
  // The FVG is the "foundation" of the zone → higher probability.
  const fvgBacked = (execPOI ?? stack.entryPOI).hasFVG || stack.layers.some((l) => l.hasFVG);
  if (fvgBacked) { pts += 10; reasons.push("FVG backed"); }

  if (ctx.killzone.active) { pts += 8; reasons.push(ctx.killzone.active.toUpperCase() + " KZ"); }
  if (rr >= 2) { pts += 5; reasons.push(`RR${rr.toFixed(1)}`); }

  const atKeyLevel = (priceLevels ?? []).some((l) =>
    target !== undefined &&
    Math.abs(l.price - target) <= ctx.atr * 0.5 &&
    (dir === "bull" ? (l.kind === "PDH" || l.kind === "PWH") : (l.kind === "PDL" || l.kind === "PWL"))
  );
  if (atKeyLevel) { pts += 10; reasons.push("draws to key level"); }

  // Slight penalty for setups not at zone (not yet actionable)
  if (!atZone) pts = Math.round(pts * 0.85);

  return { confidence: Math.min(pts, 100), reasons };
}

function classifyTradeCategory(
  stack: POIStack,
  setupType: SetupType,
  entry: number,
  target: number,
  ctx: DetectContext,
): TradeCategory {
  const atr = ctx.atr;
  const targetDistAtr = atr > 0 ? Math.abs(target - entry) / atr : 0;
  const targetPct = entry > 0 ? Math.abs(target - entry) / entry : 0;

  const anchorGroup = stack.anchorPOI.group;
  const cascade = stack.groupsCovered.length;
  const htfStructure = ctx.structureEvents.some((e) => e.direction === stack.direction);

  const swingScore =
    (anchorGroup === "macro" ? 1 : 0) +
    (cascade === 3 ? 1 : 0) +
    (targetDistAtr > 5 || targetPct > 0.02 ? 1 : 0) +
    (setupType === "CR" ? 1 : 0) +
    (htfStructure ? 1 : 0);

  if (anchorGroup === "macro" && swingScore >= 3) return "swing";
  if (setupType === "CR" && (targetDistAtr > 5 || targetPct > 0.02)) return "swing";
  if (anchorGroup === "intermediate") return "intraday";
  if (anchorGroup === "macro") return "intraday";
  if (cascade >= 2 && targetDistAtr >= 2) return "intraday";
  return "scalp";
}

function scoreLiquidity(input: {
  direction: Direction;
  entry: number;
  target: number;
  stack: POIStack;
  ctx: DetectContext;
}): { score: number; grade: LiquidityGrade; reasons: string[] } {
  const { direction, entry, target, ctx } = input;
  const atr = ctx.atr;
  const reasons: string[] = [];
  let pts = 0;

  const lo = Math.min(entry, target);
  const hi = Math.max(entry, target);
  const sweepTol = atr * 0.25;
  const clusterTol = atr * 0.5;
  const eqlTol = atr * 0.15;

  // Factor 1: Liquidity swept before entry (30 pts)
  // Bull: recent candle wicks below a swing low (SSL) and closes back above it
  // Bear: recent candle wicks above a swing high (BSL) and closes back below it
  const closed = ctx.entryCandles.filter((c) => c.closed).slice(-10);
  const sweepLevels = direction === "bull"
    ? ctx.swings.filter((s) => s.kind === "low")
    : ctx.swings.filter((s) => s.kind === "high");
  const swept = sweepLevels.some((s) =>
    closed.some((c) =>
      direction === "bull"
        ? c.low < s.price - sweepTol && c.close > s.price
        : c.high > s.price + sweepTol && c.close < s.price,
    ),
  );
  if (swept) { pts += 30; reasons.push("liquidity swept"); }

  // Factor 2: MSS displacement — sweep + aligned CHoCH = textbook ICT reversal (15 pts)
  // CHoCH alone = structural shift signal (8 pts)
  const choch = ctx.structureEvents.some(
    (e) => e.type === "CHoCH" && e.direction === direction,
  );
  if (swept && choch) { pts += 15; reasons.push("MSS displacement"); }
  else if (choch)     { pts += 8;  reasons.push("CHoCH shift"); }

  // Factor 3: Liquidity pool clustered at target (20 pts)
  // Bull targets BSL (swing highs); bear targets SSL (swing lows)
  const poolSide = direction === "bull"
    ? ctx.htfSwings.filter((s) => s.kind === "high")
    : ctx.htfSwings.filter((s) => s.kind === "low");
  const nearTarget = poolSide.filter((s) => Math.abs(s.price - target) <= clusterTol);
  if (nearTarget.length >= 1) { pts += 20; reasons.push("liq pool @ target"); }

  // Factor 4: Equal highs/lows at target — concentrated liquidity = magnetic pull (15 pts)
  let equalCluster = false;
  for (let i = 0; i < nearTarget.length; i++) {
    for (let j = i + 1; j < nearTarget.length; j++) {
      if (Math.abs(nearTarget[i]!.price - nearTarget[j]!.price) <= eqlTol) {
        equalCluster = true;
      }
    }
  }
  if (equalCluster) { pts += 15; reasons.push("equal H/L target"); }

  // Factor 5: Clear path to target — no unconsumed opposing HTF POI between entry and target (15 pts)
  const oppDir: Direction = direction === "bull" ? "bear" : "bull";
  const blockers = ctx.allPOIs.filter(
    (p) =>
      !p.consumed &&
      p.direction === oppDir &&
      p.group !== "entry" &&
      p.mid > lo + clusterTol &&
      p.mid < hi - clusterTol &&
      Math.abs(p.mid - target) > clusterTol, // exclude the target POI itself
  );
  if (blockers.length === 0) { pts += 15; reasons.push("clear path"); }
  else { reasons.push(`${blockers.length} obstacle${blockers.length > 1 ? "s" : ""}`); }

  // Factor 6: Opposing POI near entry already consumed (5 pts)
  const facingConsumed = ctx.allPOIs.some(
    (p) => p.consumed && p.direction === oppDir && Math.abs(p.mid - entry) <= atr * 2,
  );
  if (facingConsumed) { pts += 5; reasons.push("opp POI mitigated"); }

  const score = Math.min(pts, 100);
  const grade: LiquidityGrade = score >= 70 ? "A" : score >= 45 ? "B" : "C";
  return { score, grade, reasons };
}
