import { BaseCrawler } from "./base.ts";
import type { Level } from "../orderbook/book.ts";

interface BybitMsg {
  topic?: string;
  type?: "snapshot" | "delta";
  data?: {
    b: [string, string][];
    a: [string, string][];
    seq?: number;
    u?: number;
  };
  op?: string;
  success?: boolean;
}

export class BybitCrawler extends BaseCrawler {
  readonly exchange = "BYB";
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  async connect(symbol: string) {
    this.symbol = symbol.toUpperCase();
    this.openWebSocket(this.buildWsUrl(symbol));
  }

  protected buildWsUrl(_symbol: string) {
    return "wss://stream.bybit.com/v5/public/linear";
  }

  protected override onOpen() {
    this.send({ op: "subscribe", args: [`orderbook.200.${this.symbol}`] });
    // Bybit requires ping every 20s
    this.pingInterval = setInterval(() => this.send({ op: "ping" }), 20_000);
    super.onOpen();
  }

  protected onMessage(raw: string | Buffer) {
    if (typeof raw !== "string") return;
    const msg = JSON.parse(raw) as BybitMsg;
    if (!msg.topic || !msg.data) return;

    const bids: Level[] = msg.data.b.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    const asks: Level[] = msg.data.a.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));

    if (msg.type === "snapshot") {
      this.emit("snapshot", { exchange: this.exchange, symbol: this.symbol, bids, asks });
    } else if (msg.type === "delta") {
      this.emit("delta", { exchange: this.exchange, symbol: this.symbol, bids, asks });
    }
  }

  // Bybit sends full snapshot on subscribe — no separate REST call needed
  protected async fetchSnapshot() {}

  override disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    super.disconnect();
  }
}
