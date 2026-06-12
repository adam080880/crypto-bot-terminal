import { BaseCrawler } from "./base.ts";
import type { Level } from "../orderbook/book.ts";

interface GateLevel { p: string; s: number }

interface GateMsg {
  channel?: string;
  event?: "subscribe" | "all" | "update";
  result?: {
    t: number;
    id: number;
    contract: string;
    asks: GateLevel[];
    bids: GateLevel[];
  };
}

export class GateCrawler extends BaseCrawler {
  readonly exchange = "GAT";
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  async connect(symbol: string) {
    this.symbol = symbol;
    this.openWebSocket(this.buildWsUrl(symbol));
  }

  protected buildWsUrl(_symbol: string) {
    return "wss://fx-ws.gateio.ws/v4/ws/usdt";
  }

  protected override onOpen() {
    const contract = this.toContract(this.symbol);
    this.send({ time: Math.floor(Date.now() / 1000), channel: "futures.order_book", event: "subscribe", payload: [contract, "50", "0"] });
    // Gate.io keepalive
    this.pingInterval = setInterval(() => {
      this.send({ time: Math.floor(Date.now() / 1000), channel: "futures.ping", event: "" });
    }, 30_000);
    super.onOpen();
  }

  protected onMessage(raw: string | Buffer) {
    if (typeof raw !== "string") return;

    let msg: GateMsg;
    try { msg = JSON.parse(raw) as GateMsg; } catch { return; }
    if (msg.channel !== "futures.order_book" || !msg.result) return;
    if (msg.event !== "all" && msg.event !== "update") return;

    // Gate.io USDT perps: size "s" is in USD contracts ($1 each)
    // Convert to base currency qty: qty = s / price
    const toLevel = ({ p, s }: GateLevel): Level => {
      const price = parseFloat(p);
      return { price, qty: s / price };
    };

    const bids = msg.result.bids.map(toLevel);
    const asks = msg.result.asks.map(toLevel);

    if (msg.event === "all") {
      this.emit("snapshot", { exchange: this.exchange, symbol: this.symbol, bids, asks });
    } else {
      // Gate.io: s=0 means remove level
      this.emit("delta", { exchange: this.exchange, symbol: this.symbol, bids, asks });
    }
  }

  protected async fetchSnapshot() {}

  private toContract(symbol: string): string {
    // BTCUSDT → BTC_USDT
    const base = symbol.replace(/USDT$/i, "");
    return `${base.toUpperCase()}_USDT`;
  }

  override disconnect() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    super.disconnect();
  }
}
