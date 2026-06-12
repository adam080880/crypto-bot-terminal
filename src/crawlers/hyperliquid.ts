import { BaseCrawler } from "./base.ts";
import type { Level } from "../orderbook/book.ts";

interface HlLevel { px: string; sz: string; n: number }

interface HlMsg {
  channel?: string;
  data?: {
    coin: string;
    time: number;
    levels: [HlLevel[], HlLevel[]]; // [bids desc, asks asc]
  };
}

export class HyperliquidCrawler extends BaseCrawler {
  readonly exchange = "HYP";
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  async connect(symbol: string) {
    this.symbol = symbol;
    this.openWebSocket(this.buildWsUrl(symbol));
  }

  protected buildWsUrl(_symbol: string) {
    return "wss://api.hyperliquid.xyz/ws";
  }

  protected override onOpen() {
    const coin = this.toCoin(this.symbol);
    this.send({ method: "subscribe", subscription: { type: "l2Book", coin } });
    this.pingInterval = setInterval(() => this.send({ method: "ping" }), 30_000);
    super.onOpen();
  }

  protected onMessage(raw: string | Buffer) {
    if (typeof raw !== "string") return;

    let msg: HlMsg;
    try { msg = JSON.parse(raw) as HlMsg; } catch { return; }
    if (msg.channel !== "l2Book" || !msg.data?.levels) return;

    const [rawBids, rawAsks] = msg.data.levels;
    const bids: Level[] = rawBids.map(({ px, sz }) => ({ price: parseFloat(px), qty: parseFloat(sz) }));
    const asks: Level[] = rawAsks.map(({ px, sz }) => ({ price: parseFloat(px), qty: parseFloat(sz) }));

    // Hyperliquid always sends full snapshots (no incremental deltas)
    this.emit("snapshot", { exchange: this.exchange, symbol: this.symbol, bids, asks });
  }

  protected async fetchSnapshot() {}

  private toCoin(symbol: string): string {
    // BTCUSDT → BTC, ETHUSDT → ETH
    return symbol.replace(/USDT$/i, "").toUpperCase();
  }

  override disconnect() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    super.disconnect();
  }
}
