import { EventEmitter } from "events";
import type { BotPool } from "./botPool.ts";
import type { ICTSetup } from "../ict/types.ts";
import type { BinanceFuturesClient } from "./client.ts";
import type { TradeRecord, BotSnapshot, BinanceAccountBalance } from "./types.ts";
import { calcQty } from "./riskManager.ts";

// Confidence >= this threshold triggers the high-risk sizing tier
const HIGH_CONF_THRESHOLD = 60;

function cancelOrder(
  client: BinanceFuturesClient,
  symbol: string,
  orderId: number,
  isAlgo?: boolean,
): Promise<void> {
  return isAlgo
    ? client.cancelAlgoOrder(symbol, orderId)
    : client.cancelOrder(symbol, orderId);
}

export interface BotConfig {
  riskPct: number;      // normal setups: fraction of balance, e.g. 0.01 = 1%
  highRiskPct: number;  // high-confidence setups: e.g. 0.05 = 5%
  maxOpenTrades: number;
  minConfidence: number;
}

export declare interface TradingBot {
  on(event: "update", listener: () => void): this;
  emit(event: "update"): boolean;
}

export class TradingBot extends EventEmitter {
  private trades          = new Map<string, TradeRecord>();
  private executedSetups  = new Set<string>(); // keyed as `${symbol}::${setup.id}`
  private leverageSet     = new Set<string>(); // symbols where leverage is already configured
  // symbol -> timestamp after which the cooldown expires (set on startup from Binance history)
  private historyCooldown = new Map<string, number>();
  private running         = false;
  private balance: BinanceAccountBalance | null = null;
  private lastError: string | null = null;
  private balanceTimer: ReturnType<typeof setInterval> | null = null;
  private positionTimer: ReturnType<typeof setInterval> | null = null;
  private boundUpdate: () => void;

  constructor(
    private readonly pool: BotPool,
    private readonly client: BinanceFuturesClient,
    private readonly config: BotConfig,
  ) {
    super();
    this.boundUpdate = this.onPoolUpdate.bind(this);
  }

  async start(): Promise<void> {
    this.running  = true;
    this.lastError = null;

    await this.refreshBalance();
    await this.loadExistingPositions();
    await this.loadHistoryCooldown();

    this.balanceTimer  = setInterval(() => { void this.refreshBalance(); }, 30_000);
    this.positionTimer = setInterval(() => { void this.syncPositions(); }, 15_000);

    this.pool.on("update", this.boundUpdate);
    this.emit("update");
  }

  stop(): void {
    this.running = false;
    this.pool.off("update", this.boundUpdate);
    if (this.balanceTimer)  { clearInterval(this.balanceTimer);  this.balanceTimer  = null; }
    if (this.positionTimer) { clearInterval(this.positionTimer); this.positionTimer = null; }
    this.emit("update");
  }

  getSnapshot(): BotSnapshot {
    return {
      running: this.running,
      balance: this.balance,
      trades: [...this.trades.values()].sort((a, b) => b.openedAt - a.openedAt),
      lastError: this.lastError,
      lastUpdated: Date.now(),
      watchedSymbols: this.pool.getWatchedSymbols(),
    };
  }

  // Imports any positions already open on Binance into the trades map on startup.
  // Prevents re-entry and ensures syncPositions can track + clean up their zombie orders.
  private async loadExistingPositions(): Promise<void> {
    let positions;
    try {
      positions = await this.client.getPositions();
    } catch {
      return;
    }

    for (const pos of positions) {
      const amt = parseFloat(pos.positionAmt);
      if (amt === 0) continue;

      const id = `${pos.symbol}::__imported__`;
      if (this.trades.has(id)) continue;

      const direction = amt > 0 ? "bull" : "bear" as const;
      const entryPrice = parseFloat(pos.entryPrice);
      const qty = Math.abs(amt);

      this.trades.set(id, {
        id,
        symbol:       pos.symbol,
        direction,
        entryPrice,
        qty,
        stopLoss:     0,
        takeProfit:   0,
        status:       "open",
        unrealizedPnl: parseFloat(pos.unRealizedProfit),
        openedAt:     Date.now(),
        setupId:      "__imported__",
        setupType:    "imported",
        confidence:   0,
        leverage:     parseFloat(pos.leverage),
      });
    }
  }

  // Fetches Binance trade history for the last 2h and marks those symbols as
  // on cooldown. Prevents re-entry right after a position that closed before startup.
  private async loadHistoryCooldown(): Promise<void> {
    const WINDOW_MS = 2 * 60 * 60 * 1000;
    const since = Date.now() - WINDOW_MS;
    let timestamps: Map<string, number>;
    try {
      timestamps = await this.client.getRecentTradeTimestamps(since);
    } catch {
      return; // non-fatal — skip history check if API call fails
    }

    for (const [symbol, tradeTime] of timestamps) {
      // Open positions are already blocked by loadExistingPositions; skip them here
      if (this.trades.has(`${symbol}::__imported__`)) continue;
      // Cooldown expires 2h after the most recent trade on that symbol
      this.historyCooldown.set(symbol, tradeTime + WINDOW_MS);
    }
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

  private async onPoolUpdate(): Promise<void> {
    if (!this.running || !this.balance) return;

    const openCount = [...this.trades.values()].filter((t) => t.status === "open").length;

    for (const [symbol, engine] of this.pool.getEngines()) {
      const snap = engine.get();
      if (!snap || snap.price === 0) continue;

      // Set max leverage for this symbol on first encounter
      if (!this.leverageSet.has(symbol)) {
        try {
          await this.client.setMaxLeverage(symbol);
        } catch {
          // Non-fatal: Binance will use existing leverage if this fails
        }
        this.leverageSet.add(symbol);
      }

      // Skip symbol entirely if there's already an open position (bot-opened or imported)
      const hasOpenPosition = [...this.trades.values()].some(
        (t) => t.symbol === symbol && t.status === "open",
      );
      if (hasOpenPosition) continue;

      // Skip if this symbol had a trade (open or closed) within 2h before startup
      const cooldownExpiry = this.historyCooldown.get(symbol) ?? 0;
      if (cooldownExpiry > Date.now()) continue;

      for (const setup of snap.setups) {
        if (openCount >= this.config.maxOpenTrades) break;
        if (setup.status !== "triggered" && setup.status !== "active") continue;

        const key = `${symbol}::${setup.id}`;
        if (this.executedSetups.has(key)) continue;
        if (setup.confidence < this.config.minConfidence) continue;

        this.executedSetups.add(key);
        try {
          await this.executeTrade(setup, symbol, snap.price);
        } catch (err) {
          this.lastError = `Trade failed [${symbol} ${setup.id}]: ${(err as Error).message}`;
          const failed: TradeRecord = {
            id: key,
            symbol,
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
          this.trades.set(key, failed);
          this.emit("update");
        }
      }

      // Update unrealized PnL for this symbol's open trades
      const price = snap.price;
      for (const [id, trade] of this.trades) {
        if (trade.status !== "open" || trade.symbol !== symbol) continue;
        const pnl = trade.direction === "bull"
          ? (price - trade.entryPrice) * trade.qty
          : (trade.entryPrice - price) * trade.qty;
        this.trades.set(id, { ...trade, unrealizedPnl: pnl });
      }
    }
  }

  // Detects positions that closed on Binance (SL/TP hit) and cancels the zombie order.
  private async syncPositions(): Promise<void> {
    const openTrades = [...this.trades.values()].filter((t) => t.status === "open");
    if (openTrades.length === 0) return;

    // One call covers all symbols
    let openPositions: Set<string>;
    try {
      const positions = await this.client.getPositions();
      openPositions = new Set(positions.map((p) => p.symbol));
    } catch {
      return; // network glitch — skip this cycle
    }

    let changed = false;

    for (const trade of openTrades) {
      if (openPositions.has(trade.symbol)) continue; // still open, nothing to do

      // Position is gone — one of SL/TP fired. Cancel whichever order is still open.
      // Whichever cancel succeeds tells us what DIDN'T fire (i.e., the zombie).
      let closedByTP = false;

      if (trade.slOrderId !== undefined) {
        try {
          await cancelOrder(this.client, trade.symbol, trade.slOrderId, trade.slIsAlgo);
          closedByTP = true; // SL zombie cancelled → TP fired
        } catch {
          // SL already filled — SL was the one that fired
        }
      }

      if (trade.tpOrderId !== undefined) {
        try {
          await cancelOrder(this.client, trade.symbol, trade.tpOrderId, trade.tpIsAlgo);
          closedByTP = false; // TP zombie cancelled → SL fired
        } catch {
          // TP already filled — TP was the one that fired
        }
      }

      const closePrice = closedByTP ? trade.takeProfit : trade.stopLoss;
      const pnlPerUnit = trade.direction === "bull"
        ? closePrice - trade.entryPrice
        : trade.entryPrice - closePrice;

      const updated: TradeRecord = {
        ...trade,
        status:       closedByTP ? "closed" : "stopped",
        closedAt:     Date.now(),
        closePrice,
        realizedPnl:  pnlPerUnit * trade.qty,
        unrealizedPnl: 0,
      };
      this.trades.set(trade.id, updated);
      changed = true;
    }

    if (changed) {
      await this.refreshBalance();
      this.emit("update");
    }
  }

  private async executeTrade(setup: ICTSetup, symbol: string, price: number): Promise<void> {
    if (!this.balance) throw new Error("No balance data");

    const [filters, maxLev] = await Promise.all([
      this.client.getSymbolFilters(symbol),
      this.client.getMaxLeverage(symbol),
    ]);
    const side      = setup.direction === "bull" ? "BUY" : "SELL";
    const closeSide = side === "BUY" ? "SELL" : "BUY";

    // Scale risk with confidence: high-confidence setups get larger sizing
    const riskPct = setup.confidence >= HIGH_CONF_THRESHOLD
      ? this.config.highRiskPct
      : this.config.riskPct;

    const qty = calcQty({
      balance: this.balance.availableBalance,
      riskPct,
      entryPrice: price,
      stopPrice: setup.stop,
      leverage: maxLev,
      stepSize: filters.stepSize,
      minQty: filters.minQty,
      minNotional: filters.minNotional,
    });

    if (qty <= 0) throw new Error("Calculated qty is 0");

    const entryOrder = await this.client.placeMarketOrder(symbol, side, qty);

    let slOrderId: number | undefined;
    let tpOrderId: number | undefined;
    let slIsAlgo: boolean | undefined;
    let tpIsAlgo: boolean | undefined;

    try {
      const sl = await this.client.placeStopLoss(symbol, closeSide, qty, setup.stop);
      slOrderId = sl.orderId;
      slIsAlgo  = sl.isAlgo;
    } catch (err) {
      console.error("[bot] SL order failed:", (err as Error).message);
    }

    try {
      const tp = await this.client.placeTakeProfit(symbol, closeSide, qty, setup.target);
      tpOrderId = tp.orderId;
      tpIsAlgo  = tp.isAlgo;
    } catch (err) {
      console.error("[bot] TP order failed:", (err as Error).message);
    }

    const key = `${symbol}::${setup.id}`;
    const poiStack = setup.poiStack.layers
      .map((l) => `${l.timeframe} ${l.kind}`)
      .join(" → ");
    const trade: TradeRecord = {
      id: key,
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
      leverage: maxLev,
      riskPctUsed: riskPct,
      entryOrderId: entryOrder.orderId,
      slOrderId,
      tpOrderId,
      slIsAlgo,
      tpIsAlgo,
      reasons: setup.reasons,
      poiStack,
    };

    this.trades.set(key, trade);
    this.balance = await this.client.getAccount();
    this.emit("update");
  }
}
