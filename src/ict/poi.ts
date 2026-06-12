import type { POI, POIStack, POIResponse, Timeframe, TFGroup, OrderBlock, FVG, Candle } from "./types.ts";
import type { SRFlip } from "./rbs.ts";
import type { QuasimodoPattern } from "./quasimodo.ts";

export const TF_ORDER: readonly Timeframe[] =
  ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"] as const;

export function tfRank(tf: Timeframe): number {
  return TF_ORDER.indexOf(tf);
}

export function tfGroup(tf: Timeframe): TFGroup {
  switch (tf) {
    case "1m": case "5m": case "15m": return "entry";
    case "1h": case "4h":             return "intermediate";
    case "1d": case "1w": case "1M":  return "macro";
  }
}

// Next lower group in the hierarchy
const NEXT_GROUP: Partial<Record<TFGroup, TFGroup>> = {
  macro: "intermediate",
  intermediate: "entry",
};

export function obToPOI(ob: OrderBlock): POI {
  return {
    id: `OB-${ob.timeframe}-${ob.direction}-${ob.time}`,
    kind: "OB",
    direction: ob.direction,
    timeframe: ob.timeframe,
    group: tfGroup(ob.timeframe),
    top: ob.top,
    bottom: ob.bottom,
    mid: (ob.top + ob.bottom) / 2,
    time: ob.time,
    consumed: ob.mitigated,
    response: "none",
    touchedAt: null,
    wickStop: ob.wickStop,
  };
}

export function fvgToPOI(fvg: FVG): POI {
  return {
    id: `FVG-${fvg.timeframe}-${fvg.direction}-${fvg.time}`,
    kind: "FVG",
    direction: fvg.direction,
    timeframe: fvg.timeframe,
    group: tfGroup(fvg.timeframe),
    top: fvg.top,
    bottom: fvg.bottom,
    mid: (fvg.top + fvg.bottom) / 2,
    time: fvg.time,
    consumed: fvg.filled,
    response: "none",
    touchedAt: null,
  };
}

export function srFlipToPOI(sr: SRFlip): POI {
  // RBS = bullish (acts as support = long bias)
  // SBR = bearish (acts as resistance = short bias)
  const direction = sr.kind === "RBS" ? "bull" : "bear";
  return {
    id: `${sr.kind}-${sr.timeframe}-${sr.time}`,
    kind: sr.kind,
    direction,
    timeframe: sr.timeframe,
    group: tfGroup(sr.timeframe),
    top: sr.top,
    bottom: sr.bottom,
    mid: sr.price,
    time: sr.time,
    consumed: sr.invalidated,
    response: "none",
    touchedAt: null,
    touchCount: sr.touchCount,
  };
}

export function qmToPOI(qm: QuasimodoPattern): POI {
  return {
    id: `QM-${qm.timeframe}-${qm.direction}-${qm.time}`,
    kind: "QM",
    direction: qm.direction,
    timeframe: qm.timeframe,
    group: tfGroup(qm.timeframe),
    top: qm.top,
    bottom: qm.bottom,
    mid: qm.level,
    time: qm.time,
    consumed: qm.invalidated,
    response: "none",
    touchedAt: null,
    m2Price: qm.m2Price, // extreme beyond which setup is invalid (SL reference)
  };
}

export function detectPOIResponse(
  poi: POI,
  candles: readonly Candle[],
  price: number,
  atr: number,
): POIResponse {
  if (atr <= 0) return "none";
  const buf = atr * 0.15;
  if (price < poi.bottom - buf || price > poi.top + buf) return "none";

  const closed = candles.filter((c) => c.closed);
  const lastClosed = closed.at(-1);
  if (!lastClosed) return "touching";

  // Rejection wick into the zone in the correct direction
  const touchedZone = lastClosed.low <= poi.top && lastClosed.high >= poi.bottom;
  if (touchedZone) {
    const range = lastClosed.high - lastClosed.low;
    if (range > 0) {
      if (poi.direction === "bull") {
        const lowerWick = Math.min(lastClosed.open, lastClosed.close) - lastClosed.low;
        if (lowerWick > range * 0.5) return "reacting";
      } else {
        const upperWick = lastClosed.high - Math.max(lastClosed.open, lastClosed.close);
        if (upperWick > range * 0.5) return "reacting";
      }
    }
  }

  // Price moved away from mid in the correct direction after touching
  const movedAway = poi.direction === "bull"
    ? price - poi.mid >= atr * 0.5
    : poi.mid - price >= atr * 0.5;
  if (movedAway && poi.touchedAt !== null) return "reacting";

  return "touching";
}

// ─── TOP-DOWN CASCADE ────────────────────────────────────────────────────────

function zonesOverlap(a: POI, b: POI): boolean {
  return a.bottom <= b.top && a.top >= b.bottom;
}

function withinBuf(poi: POI, price: number, buf: number): boolean {
  return price >= poi.bottom - buf && price <= poi.top + buf;
}

/**
 * Recursively build all cascade chains starting from `anchor`.
 * Steps down one TF group at a time: macro → intermediate → entry.
 * Each chain is an ordered array [anchor, ..., entryPOI].
 */
function buildCascadeChains(anchor: POI, pool: readonly POI[], depth = 0): POI[][] {
  if (depth > 4) return [[anchor]]; // safety guard

  const nextGroup = NEXT_GROUP[anchor.group];

  // Try stepping to the next group first
  if (nextGroup) {
    const children = pool.filter(
      (c) =>
        c.id !== anchor.id &&
        c.group === nextGroup &&
        c.direction === anchor.direction &&
        zonesOverlap(c, anchor),
    );

    if (children.length > 0) {
      const chains: POI[][] = [];
      for (const child of children) {
        for (const sub of buildCascadeChains(child, pool, depth + 1)) {
          chains.push([anchor, ...sub]);
        }
      }
      return chains;
    }

    // No next-group found — try skipping directly to entry
    if (anchor.group === "macro") {
      const entryChildren = pool.filter(
        (c) =>
          c.id !== anchor.id &&
          c.group === "entry" &&
          c.direction === anchor.direction &&
          zonesOverlap(c, anchor),
      );
      if (entryChildren.length > 0) {
        return entryChildren.map((e) => [anchor, e]);
      }
    }
  }

  return [[anchor]]; // leaf: no children found
}

function chainToStack(chain: POI[]): POIStack | null {
  const anchor = chain.at(0);
  const entry = chain.at(-1);
  if (!anchor || !entry) return null;

  // Compute intersection of all zones (entry precision)
  let overlapTop = anchor.top;
  let overlapBottom = anchor.bottom;
  for (const p of chain) {
    overlapTop = Math.min(overlapTop, p.top);
    overlapBottom = Math.max(overlapBottom, p.bottom);
  }
  // Degenerate intersection → fall back to entry zone
  if (overlapTop < overlapBottom) {
    overlapTop = entry.top;
    overlapBottom = entry.bottom;
  }

  const groupsCovered = [...new Set(chain.map((p) => p.group))];
  const reactingLayers = chain.filter((p) => p.response === "reacting").length;

  return {
    id: `stack-${anchor.direction}-${anchor.id}`,
    direction: anchor.direction,
    layers: chain,
    entryPOI: entry,
    anchorPOI: anchor,
    depth: chain.length,
    groupsCovered,
    overlapTop,
    overlapBottom,
    reactingLayers,
  };
}

/**
 * Top-down cascade: starting from high-TF POIs, drill down through each
 * TF group to find what POIs formed within each zone.
 *
 * Buffer per group:
 *   macro       → 10 ATR  (price approaching, not necessarily inside)
 *   intermediate → 5 ATR
 *   entry        → 1 ATR  (near-touch required for a setup)
 */
export function buildPOIStacks(
  allPOIs: readonly POI[],
  price: number,
  atr: number,
  entryBufMult = 1,
): POIStack[] {
  if (atr <= 0) return [];

  // OB-only cascade: FVGs create too much noise as setup triggers.
  // FVGs remain in allPOIs for display/target-finding but not for chains.
  const obs = allPOIs.filter((p) => p.kind === "OB");

  const macros = obs.filter(
    (p) => !p.consumed && p.group === "macro" && withinBuf(p, price, atr * 10),
  );
  const intermediates = obs.filter(
    (p) => !p.consumed && p.group === "intermediate" && withinBuf(p, price, atr * 5),
  );
  const entries = obs.filter(
    (p) => !p.consumed && p.group === "entry" && withinBuf(p, price, atr * entryBufMult),
  );

  const pool: POI[] = [...macros, ...intermediates, ...entries];

  const allChains: POI[][] = [];
  const coveredEntryIds = new Set<string>();

  // ① Top-down from each macro POI
  for (const macro of macros) {
    for (const chain of buildCascadeChains(macro, pool)) {
      allChains.push(chain);
      const last = chain.at(-1);
      if (last?.group === "entry") coveredEntryIds.add(last.id);
    }
  }

  // ② Intermediate POIs without a macro parent
  for (const mid of intermediates) {
    const hasMacro = macros.some(
      (m) => m.direction === mid.direction && zonesOverlap(m, mid),
    );
    if (hasMacro) continue;
    for (const chain of buildCascadeChains(mid, pool)) {
      allChains.push(chain);
      const last = chain.at(-1);
      if (last?.group === "entry") coveredEntryIds.add(last.id);
    }
  }

  // ③ Standalone entry POIs not reachable from above
  for (const entry of entries) {
    if (!coveredEntryIds.has(entry.id)) allChains.push([entry]);
  }

  // Only keep chains whose entry POI is within the requested range
  const entryBuf = atr * entryBufMult;
  const relevant = allChains.filter((chain) => {
    const last = chain.at(-1);
    return last !== undefined && withinBuf(last, price, entryBuf);
  });

  // Convert → POIStack, deduplicate by entry POI id (keep deepest chain)
  const byEntryId = new Map<string, POIStack>();
  for (const chain of relevant) {
    const stack = chainToStack(chain);
    if (!stack) continue;
    const existing = byEntryId.get(stack.entryPOI.id);
    if (!existing || stack.depth > existing.depth) {
      byEntryId.set(stack.entryPOI.id, stack);
    }
  }

  return [...byEntryId.values()].sort((a, b) =>
    b.depth !== a.depth ? b.depth - a.depth : b.groupsCovered.length - a.groupsCovered.length,
  );
}
