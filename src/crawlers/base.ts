import { EventEmitter } from "events";
import type { Level } from "../orderbook/book.ts";

export type CrawlerStatus = "connecting" | "connected" | "disconnected" | "error";

export interface SnapshotEvent {
  exchange: string;
  symbol: string;
  bids: Level[];
  asks: Level[];
}

export interface DeltaEvent {
  exchange: string;
  symbol: string;
  bids: Level[];
  asks: Level[];
}

export interface StatusEvent {
  exchange: string;
  status: CrawlerStatus;
  error?: string;
}

export declare interface BaseCrawler {
  on(event: "snapshot", listener: (data: SnapshotEvent) => void): this;
  on(event: "delta", listener: (data: DeltaEvent) => void): this;
  on(event: "status", listener: (data: StatusEvent) => void): this;
}

export abstract class BaseCrawler extends EventEmitter {
  abstract readonly exchange: string;
  protected symbol = "";
  protected ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  abstract connect(symbol: string): Promise<void>;
  protected abstract buildWsUrl(symbol: string): string;
  protected abstract onMessage(data: string | Buffer): void;
  protected abstract fetchSnapshot(): Promise<void>;

  protected setStatus(status: CrawlerStatus, error?: string) {
    this.emit("status", { exchange: this.exchange, status, error });
  }

  protected openWebSocket(url: string) {
    this.setStatus("connecting");
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.onOpen();
    };

    this.ws.onmessage = (event) => {
      this.onMessage(event.data as string | Buffer);
    };

    this.ws.onerror = () => {
      this.setStatus("error", "WebSocket error");
    };

    this.ws.onclose = () => {
      this.setStatus("disconnected");
      if (this.shouldReconnect) this.scheduleReconnect();
    };
  }

  protected onOpen() {
    this.setStatus("connected");
    this.fetchSnapshot().catch(() => {});
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connect(this.symbol).catch(() => {});
    }, this.reconnectDelay);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  protected send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
