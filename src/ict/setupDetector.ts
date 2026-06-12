import type {
  Candle, POI, POIStack, SwingPoint, StructureEvent,
  PremiumDiscount, KillZoneStatus, ICTSetup, Direction,
  Trend, SetupType, Timeframe,
} from "./types.ts";

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
}

export function detectSetups(ctx: DetectContext): ICTSetup[] {
  if (ctx.htfTrend === "ranging" || ctx.atr === 0) return [];

  const direction: Direction = ctx.htfTrend === "bullish" ? "bull" : "bear";

  const zoneOk = direction === "bull"
    ? ctx.pd.zone !== "premium"
    : ctx.pd.zone !== "discount";
  if (!zoneOk) return [];

  const setups: ICTSetup[] = [];

  for (const stack of ctx.poiStacks) {
    if (stack.direction !== direction) continue;

    // Determine if price is actively at the zone or just approaching
    const atZone = ctx.price >= stack.overlapBottom - ctx.atr && ctx.price <= stack.overlapTop + ctx.atr;
    const setupStatus = atZone ? "active" : "watching";

    // ── POI hit → valid POI detection ──────────────────────────────────────
    // When a HTF layer has been touched and a fresh LTF POI formed after the hit,
    // use the LTF valid POI as the precise entry zone (the core concept from the images).
    const validPOI = findValidPOI(stack);

    // Entry: use valid POI zone if found (tighter, more precise), else full overlap midpoint
    const entryTop    = validPOI ? validPOI.top    : stack.overlapTop;
    const entryBottom = validPOI ? validPOI.bottom : stack.overlapBottom;
    const entry = (entryTop + entryBottom) / 2;

    // SL priority: OB wick stop → QM M2 extreme → valid POI OB stop → ATR fallback
    const obWickStop  = (validPOI ?? stack.entryPOI).kind === "OB"
      ? (validPOI ?? stack.entryPOI).wickStop
      : undefined;
    const qmStop = (validPOI ?? stack.entryPOI).kind === "QM"
      ? (validPOI ?? stack.entryPOI).m2Price
      : undefined;
    const stop = obWickStop !== undefined
      ? obWickStop
      : qmStop !== undefined
        ? qmStop
        : direction === "bull"
          ? entryBottom - ctx.atr * 0.5
          : entryTop + ctx.atr * 0.5;

    const target = findTarget(direction, ctx.price, ctx.allPOIs, ctx.htfSwings, ctx.atr);
    if (target === null) continue;

    const risk = Math.abs(entry - stop);
    if (risk <= 0) continue;
    const rr = Math.abs(target - entry) / risk;

    const setupType = classifySetup(stack, ctx);
    const { confidence, reasons } = score({ stack, ctx, rr, atZone, validPOI });
    // Watching setups use a lower confidence threshold
    if (atZone && confidence < 50) continue;
    if (!atZone && confidence < 40) continue;

    setups.push({
      id: `${setupType}-${stack.id}`,
      type: setupType,
      direction,
      timeframe: (validPOI ?? stack.entryPOI).timeframe,
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

  // The valid LTF POI must have formed at or after the HTF was touched.
  // Allow a 5m buffer for timing slippage between touch detection and candle openTime.
  const buf = 5 * 60_000;
  const validEntry = stack.layers.find(
    (l) => l.group === "entry" && l.time >= hitHTF.touchedAt! - buf,
  );
  return validEntry;
}

function classifySetup(stack: POIStack, ctx: DetectContext): SetupType {
  const recentStructure = ctx.structureEvents.some(
    (e) => e.direction === stack.direction &&
      Math.abs(e.time - stack.entryPOI.time) < 60_000 * 120,
  );

  if (stack.reactingLayers >= 2) return "CR";
  if (stack.reactingLayers >= 1 && recentStructure) return "CR";
  if (stack.entryPOI.response === "reacting") return "CB2";

  // Fallback: rejection wick on last closed candle inside the overlap zone
  const closed = ctx.entryCandles.filter((c) => c.closed);
  const lastClosed = closed.at(-1);
  if (lastClosed) {
    const inZone = lastClosed.low <= stack.overlapTop && lastClosed.high >= stack.overlapBottom;
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

  return "CB1";
}

function findTarget(
  direction: Direction,
  price: number,
  allPOIs: readonly POI[],
  htfSwings: SwingPoint[],
  atr: number,
): number | null {
  const oppDir: Direction = direction === "bull" ? "bear" : "bull";

  // Prefer opposing unconsumed macro/intermediate POI as target
  const opposing = allPOIs
    .filter((p) => !p.consumed && p.direction === oppDir && p.group !== "entry")
    .filter((p) => direction === "bull" ? p.bottom > price + atr : p.top < price - atr)
    .sort((a, b) => direction === "bull" ? a.bottom - b.bottom : b.top - a.top);

  const poi = opposing.at(0);
  if (poi) return direction === "bull" ? poi.bottom : poi.top;

  // Fallback: HTF swing
  if (direction === "bull") {
    const candidates = htfSwings
      .filter((s) => s.kind === "high" && s.price > price + atr)
      .sort((a, b) => a.price - b.price);
    return candidates.at(0)?.price ?? null;
  }
  const candidates = htfSwings
    .filter((s) => s.kind === "low" && s.price < price - atr)
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
}): { confidence: number; reasons: string[] } {
  const { stack, ctx, rr, atZone, validPOI } = input;
  const dir = stack.direction;
  let pts = 0;
  const reasons: string[] = [];

  pts += 20; reasons.push("HTF aligned");

  const correctZone = dir === "bull" ? ctx.pd.zone !== "premium" : ctx.pd.zone !== "discount";
  if (correctZone) { pts += 10; reasons.push(ctx.pd.zone); }

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

    // Extra bonus when RBS/SBR aligns with an FVG in the same stack
    const hasFVGLayer = stack.layers.some((l) => l.kind === "FVG");
    if (hasFVGLayer) { pts += 8; reasons.push(`${label}+FVG combo`); }
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
  // HTF level was touched → new LTF POI formed inside → price is reacting off
  // that fresh structure rather than a stale zone. This is the core confirmation.
  if (validPOI) {
    pts += 18; reasons.push("POI→valid OB");
    if (validPOI.kind === "OB") { pts += 5; reasons.push("valid OB entry"); }
    // Extra bonus when an FVG also sits in the stack (OB+FVG = confluence)
    const hasFVGinStack = stack.layers.some((l) => l.kind === "FVG");
    if (hasFVGinStack) { pts += 5; reasons.push("valid+FVG"); }
  }

  if (ctx.killzone.active) { pts += 8; reasons.push(ctx.killzone.active.toUpperCase() + " KZ"); }
  if (rr >= 2) { pts += 5; reasons.push(`RR${rr.toFixed(1)}`); }

  // Slight penalty for setups not at zone (not yet actionable)
  if (!atZone) pts = Math.round(pts * 0.85);

  return { confidence: Math.min(pts, 100), reasons };
}
