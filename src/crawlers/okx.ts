import { BaseCrawler } from "./base.ts";
import type { Level } from "../orderbook/book.ts";

interface OkxMsg {
  event?: string;
  action?: "snapshot" | "update";
  arg?: { channel: string; instId: string };
  data?: Array<{
    bids: [string, string, string, string][];
    asks: [string, string, string, string][];
    seqId?: number;
    prevSeqId?: number;
  }>;
}

export class OkxCrawler extends BaseCrawler {
  readonly exchange = "OKX";
  private instId = "";
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  async connect(symbol: string) {
    this.symbol = symbol;
    // BTC-USDT-SWAP format for OKX perpetuals
    this.instId = this.toInstId(symbol);
    this.openWebSocket(this.buildWsUrl(symbol));
  }

  protected buildWsUrl(_symbol: string) {
    return "wss://ws.okx.com:8443/ws/v5/public";
  }

  private toInstId(symbol: string): string {
    // BTCUSDT → BTC-USDT-SWAP
    const base = symbol.replace(/USDT$/i, "");
    return `${base.toUpperCase()}-USDT-SWAP`;
  }

  protected override onOpen() {
    this.send({ op: "subscribe", args: [{ channel: "books", instId: this.instId }] });
    // OKX requires ping every 30s
    this.pingInterval = setInterval(() => this.ws?.send("ping"), 30_000);
    super.onOpen();
  }

  protected onMessage(raw: string | Buffer) {
    if (typeof raw !== "string") return;
    if (raw === "pong") return;
    let msg: OkxMsg;
    try {
      msg = JSON.parse(raw) as OkxMsg;
    } catch {
      return;
    }
    if (!msg.data?.length || !msg.action) return;

    const entry = msg.data[0]!;
    const bids: Level[] = entry.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    const asks: Level[] = entry.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));

    if (msg.action === "snapshot") {
      this.emit("snapshot", { exchange: this.exchange, symbol: this.symbol, bids, asks });
    } else if (msg.action === "update") {
      this.emit("delta", { exchange: this.exchange, symbol: this.symbol, bids, asks });
    }
  }

  // OKX sends snapshot on subscribe
  protected async fetchSnapshot() {}

  override disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    super.disconnect();
  }
}
