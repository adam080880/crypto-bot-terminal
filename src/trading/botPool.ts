import { EventEmitter } from "events";
import { ICTEngine } from "../ict/engine.ts";
import type { ScreenerEngine } from "../screener/engine.ts";
import type { WatchedSymbol } from "./types.ts";

export const MAX_POOL_SIZE = 5;

export declare interface BotPool {
  on(event: "update", listener: () => void): this;
  emit(event: "update"): boolean;
}

export class BotPool extends EventEmitter {
  private engines   = new Map<string, ICTEngine>();
  private handlers  = new Map<string, () => void>();
  private ranks     = new Map<string, number>(); // symbol → screener rank
  private readonly onScreenerUpdate: () => void;

  constructor(
    private readonly screener: ScreenerEngine,
    private readonly primarySymbol: string,
    private readonly maxPool = MAX_POOL_SIZE,
  ) {
    super();

    // Seed pool immediately with the primary symbol so the bot has something
    // to watch while the first screener scan is still running.
    this.addEngine(primarySymbol, 1);

    this.onScreenerUpdate = () => {
      const snap = this.screener.get();
      if (snap.scanning) return; // wait for full scan to complete
      this.rotate();
    };
    screener.on("update", this.onScreenerUpdate);
  }

  private rotate(): void {
    const candidates = this.screener.getTopCandidates(this.maxPool);
    const wanted = new Map(candidates.map((c) => [c.symbol, c.rank]));
    const current = new Set(this.engines.keys());

    // Remove engines no longer in top N
    for (const sym of current) {
      if (!wanted.has(sym)) this.removeEngine(sym);
    }

    // Add engines for new top-N entries
    for (const [sym, rank] of wanted) {
      if (!this.engines.has(sym)) {
        this.addEngine(sym, rank);
      } else {
        this.ranks.set(sym, rank);
      }
    }

    this.emit("update");
  }

  private addEngine(symbol: string, rank: number): void {
    const engine = new ICTEngine();
    const handler = () => this.emit("update");
    this.handlers.set(symbol, handler);
    engine.on("update", handler);
    engine.start(symbol);
    this.engines.set(symbol, engine);
    this.ranks.set(symbol, rank);
  }

  private removeEngine(symbol: string): void {
    const engine = this.engines.get(symbol);
    if (!engine) return;
    const handler = this.handlers.get(symbol);
    if (handler) engine.off("update", handler);
    engine.stop();
    this.engines.delete(symbol);
    this.handlers.delete(symbol);
    this.ranks.delete(symbol);
  }

  getEngines(): Map<string, ICTEngine> {
    return this.engines;
  }

  getWatchedSymbols(): WatchedSymbol[] {
    return [...this.engines.entries()]
      .map(([symbol, engine]) => {
        const snap = engine.get();
        const active = snap.setups.filter(
          (s) => s.status === "active" || s.status === "triggered",
        );
        const top = active.at(0);
        return {
          symbol,
          price: snap.price,
          setupCount: active.length,
          topConfidence: top?.confidence ?? 0,
          topSetupType: top?.type ?? "",
          htfTrend: snap.htfTrend,
          screenerRank: this.ranks.get(symbol) ?? 99,
        };
      })
      .sort((a, b) => a.screenerRank - b.screenerRank);
  }

  stop(): void {
    this.screener.off("update", this.onScreenerUpdate);
    for (const sym of [...this.engines.keys()]) this.removeEngine(sym);
  }
}
