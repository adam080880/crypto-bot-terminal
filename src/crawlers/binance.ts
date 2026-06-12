import { BaseCrawler } from "./base.ts";
import type { Level } from "../orderbook/book.ts";

interface DepthUpdate {
  e: string;
  E: number;
  T: number;
  s: string;
  U: number;
  u: number;
  pu: number;
  b: [string, string][];
  a: [string, string][];
}

interface DepthSnapshot {
  lastUpdateId: number;
  E: number;
  T: number;
  bids: [string, string][];
  asks: [string, string][];
}

export class BinanceCrawler extends BaseCrawler {
  readonly exchange = "BNC";
  private lastUpdateId = 0;
  private buffer: DepthUpdate[] = [];
  private snapshotLoaded = false;

  async connect(symbol: string) {
    this.symbol = symbol.toLowerCase();
    this.buffer = [];
    this.snapshotLoaded = false;
    this.lastUpdateId = 0;
    this.openWebSocket(this.buildWsUrl(symbol));
  }

  protected buildWsUrl(symbol: string) {
    return `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@depth@100ms`;
  }

  protected onMessage(raw: string | Buffer) {
    if (typeof raw !== "string") return;
    const msg = JSON.parse(raw) as DepthUpdate;
    if (!this.snapshotLoaded) {
      this.buffer.push(msg);
      return;
    }
    this.applyUpdate(msg);
  }

  protected async fetchSnapshot() {
    const sym = this.symbol.toUpperCase();
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=1000`
    );
    const snap = (await res.json()) as DepthSnapshot;

    this.emit("snapshot", {
      exchange: this.exchange,
      symbol: this.symbol,
      bids: snap.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      asks: snap.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    });

    this.lastUpdateId = snap.lastUpdateId;
    this.snapshotLoaded = true;

    // flush buffered updates that came in while waiting for snapshot
    for (const update of this.buffer) {
      if (update.u <= this.lastUpdateId) continue;
      this.applyUpdate(update);
    }
    this.buffer = [];
  }

  private applyUpdate(msg: DepthUpdate) {
    // per Binance docs: drop if u < lastUpdateId+1
    if (msg.u < this.lastUpdateId + 1) return;
    this.lastUpdateId = msg.u;

    const bids: Level[] = msg.b.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    const asks: Level[] = msg.a.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));

    this.emit("delta", { exchange: this.exchange, symbol: this.symbol, bids, asks });
  }
}
