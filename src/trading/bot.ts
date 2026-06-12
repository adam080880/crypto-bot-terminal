import { EventEmitter } from "events";
import type { ICTEngine } from "../ict/engine.ts";
import type { ICTSetup } from "../ict/types.ts";
import type { BinanceFuturesClient } from "./client.ts";
import type { TradeRecord, BotSnapshot, BinanceAccountBalance } from "./types.ts";
import { calcQty } from "./riskManager.ts";

export interface BotConfig {
  symbol: string;
  riskPct: number;      // fraction of balance, e.g. 0.01 = 1%
  leverage: number;
  maxOpenTrades: number;
  minConfidence: number; // only trade setups above this, e.g. 70
}

export declare interface TradingBot {
  on(event: "update", listener: () => void): this;
  emit(event: "update"): boolean;
}

export class TradingBot extends EventEmitter {
  private trades = new Map<string, TradeRecord>();
  private executedSetups = new Set<string>();
  private running = false;
  private balance: BinanceAccountBalance | null = null;
  private lastError: string | null = null;
  private balanceTimer: ReturnType<typeof setInterval> | null = null;
  private boundUpdate: () => void;

  constructor(
    private readonly ictEngine: ICTEngine,
    private readonly client: BinanceFuturesClient,
    private readonly config: BotConfig,
  ) {
    super();
    this.boundUpdate = this.onICTUpdate.bind(this);
  }

  async start(): Promise<void> {
    this.running = true;
    this.lastError = null;

    // Set leverage once at start
    try {
      await this.client.setLeverage(this.config.symbol, this.config.leverage);
    } catch (err) {
      this.lastError = `Leverage setup failed: ${(err as Error).message}`;
    }

    // Fetch initial balance
    await this.refreshBalance();

    // Refresh balance every 30s
    this.balanceTimer = setInterval(() => { this.refreshBalance(); }, 30_000);

    this.ictEngine.on("update", this.boundUpdate);
    this.emit("update");
  }

  stop(): void {
    this.running = false;
    this.ictEngine.off("update", this.boundUpdate);
    if (this.balanceTimer) { clearInterval(this.balanceTimer); this.balanceTimer = null; }
    this.emit("update");
  }

  getSnapshot(): BotSnapshot {
    return {
      running: this.running,
      balance: this.balance,
      trades: [...this.trades.values()].sort((a, b) => b.openedAt - a.openedAt),
      lastError: this.lastError,
      lastUpdated: Date.now(),
    };
  }

  private async refreshBalance(): Promise<void> {
    try {
      this.balance = await this.client.getAccount();
      this.emit("update");
    } catch (err) {
      this.lastError = `Balance fetch failed: ${(err as Error).message}`;
      this.emit("update");
    }
  }

  private async onICTUpdate(): Promise<void> {
    if (!this.running || !this.balance) return;

    const snap = this.ictEngine.get();
    const openCount = [...this.trades.values()].filter((t) => t.status === "open").length;

    for (const setup of snap.setups) {
      if (openCount >= this.config.maxOpenTrades) break;
      if (setup.status !== "triggered" && setup.status !== "active") continue;
      if (this.executedSetups.has(setup.id)) continue;
      if (setup.confidence < this.config.minConfidence) continue;

      this.executedSetups.add(setup.id);
      try {
        await this.executeTrade(setup, snap.symbol, snap.price);
      } catch (err) {
        this.lastError = `Trade failed [${setup.id}]: ${(err as Error).message}`;
        // Record failed trade for visibility
        const failed: TradeRecord = {
          id: setup.id,
          symbol: snap.symbol,
          direction: setup.direction,
          entryPrice: snap.price,
          qty: 0,
          stopLoss: setup.stop,
          takeProfit: setup.target,
          status: "failed",
          unrealizedPnl: 0,
          openedAt: Date.now(),
          setupId: setup.id,
          setupType: setup.type,
          confidence: setup.confidence,
          error: (err as Error).message,
        };
        this.trades.set(setup.id, failed);
        this.emit("update");
      }
    }

    // Update unrealized PnL for open trades from current price
    const price = snap.price;
    if (price > 0) {
      for (const [id, trade] of this.trades) {
        if (trade.status !== "open") continue;
        const pnl = trade.direction === "bull"
          ? (price - trade.entryPrice) * trade.qty
          : (trade.entryPrice - price) * trade.qty;
        this.trades.set(id, { ...trade, unrealizedPnl: pnl });
      }
    }
  }

  private async executeTrade(setup: ICTSetup, symbol: string, price: number): Promise<void> {
    if (!this.balance) throw new Error("No balance data");

    const filters = await this.client.getSymbolFilters(symbol);
    const side = setup.direction === "bull" ? "BUY" : "SELL";
    const closeSide = side === "BUY" ? "SELL" : "BUY";

    const qty = calcQty({
      balance: this.balance.availableBalance,
      riskPct: this.config.riskPct,
      entryPrice: price,
      stopPrice: setup.stop,
      leverage: this.config.leverage,
      stepSize: filters.stepSize,
      minQty: filters.minQty,
      minNotional: filters.minNotional,
    });

    if (qty <= 0) throw new Error("Calculated qty is 0");

    // Entry
    const entryOrder = await this.client.placeMarketOrder(symbol, side, qty);

    // SL + TP (fire together, tolerate if one fails)
    let slOrderId: number | undefined;
    let tpOrderId: number | undefined;

    try {
      const sl = await this.client.placeStopLoss(symbol, closeSide, qty, setup.stop);
      slOrderId = sl.orderId;
    } catch (err) {
      console.error("[bot] SL order failed:", (err as Error).message);
    }

    try {
      const tp = await this.client.placeTakeProfit(symbol, closeSide, qty, setup.target);
      tpOrderId = tp.orderId;
    } catch (err) {
      console.error("[bot] TP order failed:", (err as Error).message);
    }

    const trade: TradeRecord = {
      id: setup.id,
      symbol,
      direction: setup.direction,
      entryPrice: price,
      qty,
      stopLoss: setup.stop,
      takeProfit: setup.target,
      status: "open",
      unrealizedPnl: 0,
      openedAt: Date.now(),
      setupId: setup.id,
      setupType: setup.type,
      confidence: setup.confidence,
      entryOrderId: entryOrder.orderId,
      slOrderId,
      tpOrderId,
    };

    this.trades.set(trade.id, trade);
    this.balance = await this.client.getAccount();
    this.emit("update");
  }
}
