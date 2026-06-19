import { EventEmitter } from "events";
import type { ICTSnapshot, ICTSetup, Timeframe, POI, Candle } from "./types.ts";
import { CandleFetcher } from "./candleFetcher.ts";
import { findSwings, detectStructure } from "./structure.ts";
import { findOrderBlocks } from "./orderBlock.ts";
import { findFVGs, findIFVGs } from "./fvg.ts";
import { findOCLs } from "./ocl.ts";
import { calcPremiumDiscount } from "./premiumDiscount.ts";
import { detectPhase } from "./marketPhase.ts";
import { getKillZone } from "./killzone.ts";
import { calcATR } from "./atr.ts";
import { detectSetups } from "./setupDetector.ts";
import { obToPOI, fvgToPOI, ifvgToPOI, oclToPOI, srFlipToPOI, qmToPOI, detectPOIResponse, buildPOIStacks, markFVGBacking, TF_ORDER } from "./poi.ts";
import { findSRFlips } from "./rbs.ts";
import { findQuasimodo } from "./quasimodo.ts";
import { calcPriceLevels } from "./levels.ts";

const ALL_TFS: readonly Timeframe[] = TF_ORDER;

const TF_LIMITS: Record<Timeframe, number> = {
  "1M": 60, "1w": 120, "1d": 500,
  "4h": 500, "1h": 500,
  "15m": 500, "5m": 400, "1m": 300,
};

export declare interface ICTEngine {
  on(event: "update", listener: () => void): this;
  on(event: "setup-active", listener: (setup: ICTSetup) => void): this;
  emit(event: "update"): boolean;
  emit(event: "setup-active", setup: ICTSetup): boolean;
}

export class ICTEngine extends EventEmitter {
  private fetchers: Record<Timeframe, CandleFetcher>;
  private activeSetups = new Map<string, ICTSetup>();
  private symbol = "";
  private snapshot: ICTSnapshot;
  private prevSetupStatuses = new Map<string, string>();

  // Tiered cache
  private poiCache = new Map<Timeframe, POI[]>();
  private atrEntry = 0;
  private lastTickEmitMs = 0;

  constructor() {
    super();
    this.fetchers = {
      "1M": new CandleFetcher("1M", TF_LIMITS["1M"]),
      "1w": new CandleFetcher("1w", TF_LIMITS["1w"]),
      "1d": new CandleFetcher("1d", TF_LIMITS["1d"]),
      "4h": new CandleFetcher("4h", TF_LIMITS["4h"]),
      "1h": new CandleFetcher("1h", TF_LIMITS["1h"]),
      "15m": new CandleFetcher("15m", TF_LIMITS["15m"]),
      "5m":  new CandleFetcher("5m",  TF_LIMITS["5m"]),
      "1m":  new CandleFetcher("1m",  TF_LIMITS["1m"]),
    };
    this.snapshot = this.emptySnapshot();

    for (const tf of ALL_TFS) {
      // Tier 1+3: on candle close, recompute that TF's POIs + full analysis
      this.fetchers[tf].on("closed", () => {
        this.recomputePOIs(tf);
        this.analyze();
        this.emit("update");
      });

      // Tier 2: on live tick, update price + POI responses (throttled)
      this.fetchers[tf].on("update", () => {
        this.refreshPrice();
        const now = Date.now();
        if (now - this.lastTickEmitMs >= 250) {
          this.lastTickEmitMs = now;
          this.emit("update");
        }
      });
    }
  }

  start(symbol: string): void {
    this.symbol = symbol;
    this.snapshot = { ...this.emptySnapshot(), symbol };
    this.activeSetups.clear();
    this.poiCache.clear();
    this.atrEntry = 0;
    this.prevSetupStatuses.clear();

    Promise.all(
      ALL_TFS.map((tf) => this.fetchers[tf].start(symbol).catch(() => {})),
    ).then(() => {
      for (const tf of ALL_TFS) this.recomputePOIs(tf);
      this.analyze();
      this.emit("update");
    }).catch(() => {});
  }

  stop(): void {
    for (const tf of ALL_TFS) this.fetchers[tf].stop();
  }

  get(): ICTSnapshot { return this.snapshot; }

  getAllCandles(): Map<Timeframe, Candle[]> {
    const map = new Map<Timeframe, Candle[]>();
    for (const tf of ALL_TFS) map.set(tf, [...this.fetchers[tf].getCandles()]);
    return map;
  }

  private emptySnapshot(): ICTSnapshot {
    return {
      symbol: "",
      price: 0,
      htfTrend: "ranging",
      phase: "accumulation",
      premiumDiscount: { rangeHigh: 0, rangeLow: 0, equilibrium: 0, current: 0, zone: "equilibrium", pct: 0.5 },
      killzone: { active: null, next: null, utcHour: 0 },
      swings: [],
      pois: [],
      structureEvents: [],
      setups: [],
      priceLevels: [],
      updatedAt: 0,
    };
  }

  // Tier 1: recompute POIs for a single TF (called on that TF's candle close only)
  private recomputePOIs(tf: Timeframe): void {
    const candles = this.fetchers[tf].getCandles();
    if (candles.length < 5) { this.poiCache.set(tf, []); return; }

    const obs = findOrderBlocks(candles, tf);
    const fvgs = findFVGs(candles, tf);
    const ifvgs = findIFVGs(candles, tf);
    const ocls = findOCLs(candles, tf);
    const srFlips = findSRFlips(candles, tf);
    // QM on entry + intermediate timeframes
    const qms = (tf === "1m" || tf === "5m" || tf === "15m" || tf === "1h" || tf === "4h")
      ? findQuasimodo(candles, tf) : [];
    const fresh: POI[] = [
      ...obs.map(obToPOI),
      ...fvgs.map(fvgToPOI),
      ...ifvgs.map(ifvgToPOI),
      ...ocls.map(oclToPOI),
      ...srFlips.map(srFlipToPOI),
      ...qms.map(qmToPOI),
    ];

    // Preserve response/touchedAt for stable POIs (same id = same zone)
    const prevById = new Map((this.poiCache.get(tf) ?? []).map((p) => [p.id, p]));
    const merged = fresh.map((p): POI => {
      const prev = prevById.get(p.id);
      return prev ? { ...p, response: prev.response, touchedAt: prev.touchedAt } : p;
    });

    this.poiCache.set(tf, merged);
  }

  // Tier 2: live price + response update, no POI recomputation
  private refreshPrice(): void {
    const last = this.fetchers["1m"].getCandles().at(-1)
      ?? this.fetchers["5m"].getCandles().at(-1);
    if (!last) return;
    const price = last.close;

    // Always update price immediately — don't gate on ATR
    this.snapshot = { ...this.snapshot, price };

    const closed1m = this.fetchers["1m"].getCandles().filter((c) => c.closed);
    if (closed1m.length >= 2) this.atrEntry = calcATR(closed1m);
    if (this.atrEntry === 0) return;

    const entryCandles = this.fetchers["1m"].getCandles();

    for (const [tf, pois] of this.poiCache) {
      const updated = pois.map((p): POI => {
        if (p.consumed) return p;
        const buf = this.atrEntry * 0.15;
        const inZone = price >= p.bottom - buf && price <= p.top + buf;
        const touchedAt = p.touchedAt ?? (inZone ? Date.now() : null);
        const response = detectPOIResponse({ ...p, touchedAt }, entryCandles, price, this.atrEntry);
        return { ...p, response, touchedAt };
      });
      this.poiCache.set(tf, updated);
    }
  }

  // Tier 3: full analysis using cached POIs
  private analyze(): void {
    const entryC = this.fetchers["15m"].getCandles();
    const htfC = this.fetchers["1d"].getCandles();
    const midC = this.fetchers["4h"].getCandles();

    if (htfC.length < 5 || entryC.length < 5) return;

    const price = this.fetchers["1m"].getCandles().at(-1)?.close
      ?? this.fetchers["5m"].getCandles().at(-1)?.close
      ?? this.snapshot.price;

    // ATR from 15m for setup sizing
    const closed15m = entryC.filter((c) => c.closed);
    const atr = calcATR(closed15m) || this.atrEntry;

    // HTF structure from 1d
    const htfSwings = findSwings(htfC, 2);
    const { trend: htfTrend, events: htfEvents } = detectStructure(htfC, htfSwings);

    // Mid structure from 4h
    const midSwings = findSwings(midC, 2);
    const { events: midEvents } = detectStructure(midC, midSwings);

    // Entry structure from 15m
    const entrySwings = findSwings(entryC, 2);
    const { events: entryEvents } = detectStructure(entryC, entrySwings);

    const allEvents = [...htfEvents, ...midEvents, ...entryEvents]
      .sort((a, b) => b.time - a.time);

    const pd = calcPremiumDiscount(htfSwings, price);
    const phase = detectPhase(htfC, htfSwings, htfTrend);
    const killzone = getKillZone();

    // Compute price levels (PDH/PDL/PDO/PWH/PWL/PWO)
    const weeklyC = this.fetchers["1w"].getCandles();
    const priceLevels = calcPriceLevels(htfC, weeklyC);

    // Flatten all cached POIs
    const allPOIs: POI[] = [];
    for (const pois of this.poiCache.values()) allPOIs.push(...pois);

    // Flag entry POIs backed by a nearby same-TF FVG (Materi 2: higher probability)
    markFVGBacking(allPOIs, atr);

    // Build POI stacks — wide buffer (20 ATR) to capture approaching setups too
    const stacks = buildPOIStacks(allPOIs, price, atr, 20);

    // Detect setups
    const newSetups = detectSetups({
      symbol: this.symbol,
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
      priceLevels,
    });

    // Type quality rank — used to upgrade a stale lower-quality entry for the same stack
    const TYPE_RANK: Record<string, number> = { CB1: 1, CB2: 2, CR: 3 };

    for (const s of newSetups) {
      if (this.activeSetups.has(s.id)) continue; // same id already tracked

      // If the same stack already has a lower-quality type entry, replace it so we
      // don't accumulate duplicate "CB1-stackX" + "CB2-stackX" for the same zone.
      const stale = [...this.activeSetups.values()].find(
        (e) => e.poiStack.id === s.poiStack.id
          && (TYPE_RANK[s.type] ?? 0) > (TYPE_RANK[e.type] ?? 0),
      );
      if (stale) this.activeSetups.delete(stale.id);

      this.activeSetups.set(s.id, s);
    }

    // Reconcile status
    for (const [id, setup] of this.activeSetups) {
      if (setup.status === "watching") {
        // Promote to active when price enters within 1 ATR
        const inRange = price >= setup.zoneBottom - atr && price <= setup.zoneTop + atr;
        if (inRange) { this.activeSetups.set(id, { ...setup, status: "active" }); continue; }
        // Expire watching setups after 48 candle-periods (~12h on 15m)
        if (Date.now() - setup.createdAt > 48 * 15 * 60_000) {
          this.activeSetups.set(id, { ...setup, status: "expired" });
        }
        continue;
      }
      if (setup.status !== "active") continue;
      if (Date.now() - setup.createdAt > 12 * 15 * 60_000) {
        this.activeSetups.set(id, { ...setup, status: "expired" }); continue;
      }
      // Require a closed candle inside the zone — live wick alone is not enough.
      const closedInZone = this.fetchers["1m"].getCandles()
        .filter((c) => c.closed)
        .slice(-3)
        .some((c) => c.close >= setup.zoneBottom && c.close <= setup.zoneTop);
      if (closedInZone) {
        this.activeSetups.set(id, { ...setup, status: "triggered" }); continue;
      }
      const stopped = setup.direction === "bull" ? price < setup.stop : price > setup.stop;
      if (stopped) this.activeSetups.set(id, { ...setup, status: "invalid" });
    }

    // Emit alert when a setup transitions watching → active/triggered
    for (const [id, setup] of this.activeSetups) {
      const prev = this.prevSetupStatuses.get(id);
      if (prev === "watching" && (setup.status === "active" || setup.status === "triggered")) {
        this.emit("setup-active", setup);
      }
      this.prevSetupStatuses.set(id, setup.status);
    }

    // Cleanup prevSetupStatuses for setups that no longer exist
    for (const id of this.prevSetupStatuses.keys()) {
      if (!this.activeSetups.has(id)) this.prevSetupStatuses.delete(id);
    }

    // Prune old inactive
    const inactive = [...this.activeSetups.values()]
      .filter((s) => s.status !== "active" && s.status !== "triggered" && s.status !== "watching")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(5);
    for (const s of inactive) this.activeSetups.delete(s.id);

    const allVisible = [...this.activeSetups.values()];
    // Active/triggered always shown, watching shown up to 6 (closest first)
    const activeTrig = allVisible
      .filter((s) => s.status === "active" || s.status === "triggered")
      .sort((a, b) => b.confidence - a.confidence);
    const watching = allVisible
      .filter((s) => s.status === "watching")
      .sort((a, b) => {
        const da = Math.min(Math.abs(price - a.zoneTop), Math.abs(price - a.zoneBottom));
        const db = Math.min(Math.abs(price - b.zoneTop), Math.abs(price - b.zoneBottom));
        return da - db;
      })
      .slice(0, 6);
    const visibleSetups = [...activeTrig, ...watching];

    // Top unconsumed POIs near price for display
    const displayPOIs = allPOIs
      .filter((p) => !p.consumed && price >= p.bottom - atr * 3 && price <= p.top + atr * 3)
      .sort((a, b) => {
        const da = Math.abs(a.mid - price);
        const db = Math.abs(b.mid - price);
        return da - db;
      })
      .slice(0, 12);

    this.snapshot = {
      symbol: this.symbol,
      price,
      htfTrend,
      phase,
      premiumDiscount: pd,
      killzone,
      swings: entrySwings.slice(-20),
      pois: displayPOIs,
      structureEvents: allEvents,
      setups: visibleSetups,
      priceLevels,
      updatedAt: Date.now(),
    };
  }
}
