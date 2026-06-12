import { BaseCrawler } from "./base.ts";
import type { Level } from "../orderbook/book.ts";

interface BingxMsg {
  code?: number;
  dataType?: string;
  data?: {
    bids?: [string, string][];
    asks?: [string, string][];
  };
}

export class BingxCrawler extends BaseCrawler {
  readonly exchange = "BGX";
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  async connect(symbol: string) {
    this.symbol = symbol;
    this.openWebSocket(this.buildWsUrl(symbol));
  }

  protected buildWsUrl(_symbol: string) {
    return "wss://open-api-ws.bingx.com/market";
  }

  protected override onOpen() {
    const bingxSymbol = this.toBingxSymbol(this.symbol);
    this.send({
      id: "depth",
      reqType: "sub",
      dataType: `${bingxSymbol}@depth20`,
    });
    // BingX requires ping every 5s to keep connection alive
    this.pingInterval = setInterval(() => this.ws?.send("Ping"), 5_000);
    super.onOpen();
  }

  protected onMessage(data: string | Buffer) {
    let raw: string;
    if (typeof data !== "string") {
      try {
        const buf = data as Buffer;
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        raw = Buffer.from(Bun.gunzipSync(new Uint8Array(ab))).toString();
      } catch {
        raw = Buffer.from(data as Buffer).toString();
      }
    } else {
      raw = data;
    }

    if (raw === "Pong") return;

    let msg: BingxMsg;
    try {
      msg = JSON.parse(raw) as BingxMsg;
    } catch {
      return;
    }

    if (!msg.data) return;

    const bids: Level[] = (msg.data.bids ?? []).map(([p, q]) => ({
      price: parseFloat(p),
      qty: parseFloat(q),
    }));
    const asks: Level[] = (msg.data.asks ?? []).map(([p, q]) => ({
      price: parseFloat(p),
      qty: parseFloat(q),
    }));

    if (bids.length === 0 && asks.length === 0) return;

    // BingX depth20 always sends full snapshot
    this.emit("snapshot", { exchange: this.exchange, symbol: this.symbol, bids, asks });
  }

  protected async fetchSnapshot() {}

  private toBingxSymbol(symbol: string): string {
    // BTCUSDT → BTC-USDT
    const base = symbol.replace(/USDT$/i, "");
    return `${base.toUpperCase()}-USDT`;
  }

  override disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    super.disconnect();
  }
}
