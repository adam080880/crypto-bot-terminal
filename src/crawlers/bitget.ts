import { BaseCrawler } from "./base.ts";
import type { Level } from "../orderbook/book.ts";

interface BitgetMsg {
  action?: "snapshot" | "update";
  arg?: { instType: string; channel: string; instId: string };
  data?: Array<{ asks: [string, string][]; bids: [string, string][]; ts: string }>;
  op?: string;
  event?: string;
}

export class BitgetCrawler extends BaseCrawler {
  readonly exchange = "BGT";
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  async connect(symbol: string) {
    this.symbol = symbol.toUpperCase();
    this.openWebSocket(this.buildWsUrl(symbol));
  }

  protected buildWsUrl(_symbol: string) {
    return "wss://ws.bitget.com/v2/ws/public";
  }

  protected override onOpen() {
    this.send({ op: "subscribe", args: [{ instType: "USDT-FUTURES", channel: "books", instId: this.symbol }] });
    this.pingInterval = setInterval(() => this.send({ op: "ping" }), 30_000);
    super.onOpen();
  }

  protected onMessage(raw: string | Buffer) {
    if (typeof raw !== "string") return;
    if (raw === "pong") return;

    let msg: BitgetMsg;
    try { msg = JSON.parse(raw) as BitgetMsg; } catch { return; }
    if (!msg.data?.length || !msg.action) return;

    const entry = msg.data[0]!;
    const bids: Level[] = entry.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    const asks: Level[] = entry.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));

    if (msg.action === "snapshot") {
      this.emit("snapshot", { exchange: this.exchange, symbol: this.symbol, bids, asks });
    } else {
      this.emit("delta", { exchange: this.exchange, symbol: this.symbol, bids, asks });
    }
  }

  protected async fetchSnapshot() {}

  override disconnect() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    super.disconnect();
  }
}
