import { EventEmitter } from "events";
import type { Candle, Timeframe } from "./types.ts";

interface KlineMsg {
  e: string;
  k: {
    t: number; T: number;
    o: string; h: string; l: string; c: string; v: string;
    x: boolean;
  };
}

type KlineRow = [number, string, string, string, string, string, number, ...unknown[]];

export declare interface CandleFetcher {
  on(event: "update", listener: (tf: Timeframe) => void): this;
  on(event: "closed", listener: (tf: Timeframe, candle: Candle) => void): this;
  emit(event: "update", tf: Timeframe): boolean;
  emit(event: "closed", tf: Timeframe, candle: Candle): boolean;
}

export class CandleFetcher extends EventEmitter {
  private candles: Candle[] = [];
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private symbol = "";

  constructor(
    readonly timeframe: Timeframe,
    private readonly limit: number,
  ) { super(); }

  async start(symbol: string): Promise<void> {
    this.symbol = symbol.toLowerCase();
    this.shouldReconnect = true;
    await this.seed();
    this.openWS();
  }

  stop(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
  }

  getCandles(): readonly Candle[] { return this.candles; }

  private async seed(): Promise<void> {
    const sym = this.symbol.toUpperCase();
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${this.timeframe}&limit=${this.limit}`;
    const res = await fetch(url);
    const raw = (await res.json()) as KlineRow[];
    this.candles = raw.map((r) => ({
      openTime: r[0],
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
      closeTime: r[6],
      closed: true,
    }));
    // Last candle from REST may still be live
    const last = this.candles.at(-1);
    if (last) this.candles[this.candles.length - 1] = { ...last, closed: false };
    this.emit("update", this.timeframe);
  }

  private openWS(): void {
    const url = `wss://fstream.binance.com/ws/${this.symbol}@kline_${this.timeframe}`;
    this.ws = new WebSocket(url);

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as KlineMsg;
      if (msg.e !== "kline") return;
      const k = msg.k;
      const candle: Candle = {
        openTime: k.t, open: parseFloat(k.o), high: parseFloat(k.h),
        low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v),
        closeTime: k.T, closed: k.x,
      };

      const last = this.candles.at(-1);
      if (last && last.openTime === candle.openTime) {
        this.candles[this.candles.length - 1] = candle;
      } else {
        this.candles.push(candle);
        if (this.candles.length > this.limit) {
          this.candles = this.candles.slice(-this.limit);
        }
      }

      this.emit("update", this.timeframe);
      if (candle.closed) this.emit("closed", this.timeframe, candle);
    };

    this.ws.onerror = () => { this.ws?.close(); };
    this.ws.onclose = () => { if (this.shouldReconnect) this.scheduleReconnect(); };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.seed().then(() => this.openWS()).catch(() => this.scheduleReconnect());
    }, this.reconnectDelay);
  }
}
