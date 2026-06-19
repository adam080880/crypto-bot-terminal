import { EventEmitter } from "events";
import type { BotPool } from "./botPool.ts";
import type { ICTSetup, ICTSnapshot } from "../ict/types.ts";
import type { BinanceFuturesClient } from "./client.ts";
import type { TradeRecord, BotSnapshot, BinanceAccountBalance } from "./types.ts";
import { calcQty } from "./riskManager.ts";

// Confidence >= this threshold triggers the high-risk sizing tier
const HIGH_CONF_THRESHOLD = 60;

// Dynamic exit thresholds — not prompted, tune here directly
const ANOMALY_EXIT_RISK    = 1.5;   // close if adverse price moves > 1.5× stop distance within the window
const ANOMALY_WINDOW_MS    = 60_000; // velocity window: 60 seconds
const PROFIT_PROTECT_MIN   = 0.5;   // peak pnl must reach 0.5× risk before profit-protect activates
const PROFIT_PROTECT_DROP  = 0.7;   // close once pnl retreats 0.7× risk from peak

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
  riskPct: number;           // normal setups: fraction of balance, e.g. 0.01 = 1%
  highRiskPct: number;       // high-confidence setups: e.g. 0.05 = 5%
  maxOpenTrades: number;
  minConfidence: number;
  minLiquidityScore: number; // 0–100; require liquidity sweep + clear path before entry
  requireCB2orCR: boolean;   // skip CB1 (no HTF hit yet) — only CB2/CR qualify
  minRR: number;             // minimum R:R ratio (stacks on top of detector per-category floors)
  onlySymbols?: Set<string>; // when set, only these symbols are traded
}

export declare interface TradingBot {
  on(event: "update", listener: () => void): this;
  emit(event: "update"): boolean;
}

export class TradingBot extends EventEmitter {
  private trades          = new Map<string, TradeRecord>();
  private executedSetups  = new Set<string>(); // keyed as `${symbol}::${setup.id}`
  private leverageSet     = new Set<string>(); // symbols where leverage is already configured
  // Per-trade runtime metrics for dynamic exit logic (not persisted)
  private tradeMetrics    = new Map<string, { peakPnl: number; lastPrice: number; lastPriceTime: number }>();
  // symbol -> timestamp after which the cooldown expires (set on startup from Binance history)
  private historyCooldown = new Map<string, number>();
  private running         = false;
  private processing      = false; // mutex: only one onPoolUpdate runs at a time
  private startupSeeded   = false; // true after first pool update seeds existing setups
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
    // Serialize: drop incoming calls while one is already running.
    // Without this, rapid pool updates (tick-level) cause concurrent instances
    // that all see hasActiveTrade=false before any of them adds to this.trades,
    // resulting in multiple orders for the same symbol.
    if (this.processing) return;
    this.processing = true;

    try {
      // On the very first update, seed executedSetups with all currently active/triggered
      // setups so the bot does not fire limit orders for zones that already existed at startup.
      // Only setups that appear (or re-activate) after this point will trigger trades.
      if (!this.startupSeeded) {
        this.startupSeeded = true;
        for (const [symbol, engine] of this.pool.getEngines()) {
          const snap = engine.get();
          if (!snap) continue;
          for (const setup of snap.setups) {
            if (setup.status === "active" || setup.status === "triggered") {
              this.executedSetups.add(`${symbol}::${setup.id}`);
            }
          }
        }
        this.emit("update");
        return;
      }

      let openCount = [...this.trades.values()].filter((t) => t.status === "open" || t.status === "pending").length;

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

        // Skip symbols not in the --only whitelist
        if (this.config.onlySymbols && !this.config.onlySymbols.has(symbol)) continue;

        // Skip symbol entirely if there's already an open OR pending trade.
        // "pending" = limit order placed but not yet filled — still counts as committed capital.
        const hasActiveTrade = [...this.trades.values()].some(
          (t) => t.symbol === symbol && (t.status === "open" || t.status === "pending"),
        );
        if (hasActiveTrade) continue;

        // Skip if this symbol had a trade (open or closed) within 2h before startup.
        // Bypassed when --only explicitly targets this symbol (user wants forced re-entry).
        const cooldownExpiry = this.historyCooldown.get(symbol) ?? 0;
        if (cooldownExpiry > Date.now() && !this.config.onlySymbols?.has(symbol)) continue;

        for (const setup of snap.setups) {
          if (openCount >= this.config.maxOpenTrades) break;
          // Place limit order when price is approaching the zone (active) or has entered (triggered)
          if (setup.status !== "active" && setup.status !== "triggered") continue;

          const key = `${symbol}::${setup.id}`;
          if (this.executedSetups.has(key)) continue;
          if (setup.confidence < this.config.minConfidence) continue;
          if (this.config.requireCB2orCR && setup.type === "CB1") continue;
          if ((setup.liquidityScore ?? 0) < this.config.minLiquidityScore) continue;
          if (setup.rr < this.config.minRR) continue;

          this.executedSetups.add(key);
          try {
            await this.executeLimitTrade(setup, symbol);
            openCount++;
            break; // one trade per symbol — highest-confidence setup wins
          } catch (err) {
            this.lastError = `Trade failed [${symbol} ${setup.id}]: ${(err as Error).message}`;
            // Limit price is zoneBottom (bull) or zoneTop (bear)
            const limitPrice = setup.direction === "bull" ? setup.zoneBottom : setup.zoneTop;
            const failed: TradeRecord = {
              id: key,
              symbol,
              direction: setup.direction,
              entryPrice: limitPrice,
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
            break; // don't try other setups for this symbol after a placement failure
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

        // Dynamic exit: anomaly spike + profit protection
        await this.checkDynamicExits(symbol, price);

        // MSS-based exit/cancel: opposing structure shift invalidates the trade bias
        await this.checkMSSExits(symbol, snap);
      }
    } finally {
      this.processing = false;
    }
  }

  // Checks two dynamic exit conditions for every open trade on `symbol`:
  //
  //   1. Anomaly spike — adverse price velocity > ANOMALY_EXIT_RISK × riskPerUnit
  //      within ANOMALY_WINDOW_MS. Catches sudden dumps/pumps against the position.
  //
  //   2. Profit protection — once peak unrealized PnL exceeded 0.5 × risk, close
  //      if the PnL then retreats by PROFIT_PROTECT_DROP × risk from that peak.
  //      Locks in partial profit instead of riding a full reversal back to SL.
  private async checkDynamicExits(symbol: string, currentPrice: number): Promise<void> {
    for (const [id, trade] of this.trades) {
      if (trade.status !== "open" || trade.symbol !== symbol) continue;
      if (!trade.riskPerUnit || trade.riskPerUnit <= 0) continue;

      const riskAmount  = trade.riskPerUnit * trade.qty;
      const now         = Date.now();
      const metrics     = this.tradeMetrics.get(id) ?? {
        peakPnl:       0,
        lastPrice:     currentPrice,
        lastPriceTime: now,
      };

      const updatedPeak = Math.max(metrics.peakPnl, trade.unrealizedPnl);

      let shouldClose  = false;
      let closeReason  = "";

      // ── 1. Anomaly velocity check ────────────────────────────────────────
      const elapsed = now - metrics.lastPriceTime;
      if (elapsed >= ANOMALY_WINDOW_MS) {
        const adverseMove = trade.direction === "bull"
          ? metrics.lastPrice - currentPrice   // price dropped against bull
          : currentPrice - metrics.lastPrice;  // price rose against bear
        if (adverseMove > trade.riskPerUnit * ANOMALY_EXIT_RISK) {
          shouldClose  = true;
          closeReason  = `anomaly ${(adverseMove / trade.riskPerUnit).toFixed(1)}× risk/${(elapsed / 1000).toFixed(0)}s`;
        }
        this.tradeMetrics.set(id, { peakPnl: updatedPeak, lastPrice: currentPrice, lastPriceTime: now });
      } else {
        this.tradeMetrics.set(id, { ...metrics, peakPnl: updatedPeak });
      }

      // ── 2. Profit protection ─────────────────────────────────────────────
      if (!shouldClose && updatedPeak > riskAmount * PROFIT_PROTECT_MIN) {
        const retreat = updatedPeak - trade.unrealizedPnl;
        if (retreat > riskAmount * PROFIT_PROTECT_DROP) {
          shouldClose = true;
          closeReason = `profit protect peak+${updatedPeak.toFixed(2)} → ${trade.unrealizedPnl.toFixed(2)}`;
        }
      }

      if (shouldClose) {
        await this.forceClosePosition(trade, currentPrice, closeReason);
      }
    }
  }

  // Reacts to a new opposing MSS (CHoCH or BOS) that formed after a trade was placed:
  //   - pending limit order  → cancel it immediately (setup invalidated before fill)
  //   - open position        → market close (bias has shifted, SL wait is pointless)
  //
  // "After the trade was placed" is enforced by comparing event.time > trade.openedAt,
  // so pre-existing structure events never trigger a spurious exit on startup.
  private async checkMSSExits(symbol: string, snap: ICTSnapshot): Promise<void> {
    for (const [id, trade] of this.trades) {
      if (trade.symbol !== symbol) continue;
      if (trade.status !== "open" && trade.status !== "pending") continue;

      const opposingDir = trade.direction === "bull" ? "bear" : "bull";

      // Find the most recent opposing MSS that formed after this trade was placed
      const triggerEvent = snap.structureEvents
        .filter((e) => e.direction === opposingDir && e.time > trade.openedAt)
        .sort((a, b) => b.time - a.time)
        .at(0);

      if (!triggerEvent) continue;

      const label = `opposing ${triggerEvent.type} @ ${triggerEvent.level.toFixed(2)}`;

      if (trade.status === "pending") {
        // Cancel the unfilled limit order — no point waiting for a fill in a broken structure
        if (trade.limitOrderId !== undefined) {
          try { await this.client.cancelOrder(trade.symbol, trade.limitOrderId); } catch {}
        }
        this.trades.set(id, { ...trade, status: "cancelled", error: `MSS: ${label}` });
        this.executedSetups.delete(id); // allow re-entry when fresh setup forms
        this.emit("update");
      } else {
        // Close the open position — structure has shifted against us
        await this.forceClosePosition(trade, snap.price, `MSS: ${label}`);
      }
    }
  }

  // Cancels SL+TP orders and fires a reduce-only market close for a trade.
  private async forceClosePosition(trade: TradeRecord, currentPrice: number, reason: string): Promise<void> {
    const closeSide = trade.direction === "bull" ? "SELL" : "BUY";

    if (trade.slOrderId !== undefined) {
      try { await cancelOrder(this.client, trade.symbol, trade.slOrderId, trade.slIsAlgo); } catch {}
    }
    if (trade.tpOrderId !== undefined) {
      try { await cancelOrder(this.client, trade.symbol, trade.tpOrderId, trade.tpIsAlgo); } catch {}
    }

    try {
      await this.client.closePosition(trade.symbol, closeSide, trade.qty);
    } catch (err) {
      this.lastError = `Force close failed [${trade.symbol}]: ${(err as Error).message}`;
      return;
    }

    const pnlPerUnit = trade.direction === "bull"
      ? currentPrice - trade.entryPrice
      : trade.entryPrice - currentPrice;

    this.trades.set(trade.id, {
      ...trade,
      status:        "closed",
      closedAt:      Date.now(),
      closePrice:    currentPrice,
      realizedPnl:   pnlPerUnit * trade.qty,
      unrealizedPnl: 0,
      error:         reason,
    });
    this.tradeMetrics.delete(trade.id);
    this.lastError = `[auto-close] ${trade.symbol}: ${reason}`;
    await this.refreshBalance();
    this.emit("update");
  }

  // Detects:
  // 1. Pending limit orders that filled (position appeared) → place SL+TP, mark open
  // 2. Pending limit orders to cancel (SL blown while waiting, or timed out)
  // 3. Open positions that closed on Binance (SL/TP hit) → cancel zombie order
  private async syncPositions(): Promise<void> {
    const pendingTrades = [...this.trades.values()].filter((t) => t.status === "pending");
    const openTrades    = [...this.trades.values()].filter((t) => t.status === "open");
    if (pendingTrades.length === 0 && openTrades.length === 0) return;

    let positions: import("./types.ts").BinancePosition[];
    try {
      positions = await this.client.getPositions(); // already filtered to non-zero
    } catch {
      return;
    }

    const openPositions = new Set(positions.map((p) => p.symbol));
    let changed = false;

    // ── 1. Pending limit orders ──────────────────────────────────────────────
    for (const trade of pendingTrades) {
      const pos = positions.find((p) => p.symbol === trade.symbol);

      if (pos) {
        // Limit filled — position now exists on Binance
        const fillPrice = parseFloat(pos.entryPrice);
        await this.placeSLTP(trade, fillPrice);
        this.trades.set(trade.id, { ...trade, status: "open", entryPrice: fillPrice });
        changed = true;
        continue;
      }

      // Not filled yet — cancel if SL level was violated or order is too old (48 h)
      const currentPrice = this.pool.getEngines().get(trade.symbol)?.get().price ?? 0;
      const slBlown = currentPrice > 0 && (
        trade.direction === "bull"
          ? currentPrice < trade.stopLoss
          : currentPrice > trade.stopLoss
      );
      const timedOut = Date.now() - trade.openedAt > 48 * 60 * 60_000;

      if (slBlown || timedOut) {
        if (trade.limitOrderId !== undefined) {
          try { await this.client.cancelOrder(trade.symbol, trade.limitOrderId); } catch {}
        }
        this.trades.set(trade.id, { ...trade, status: "cancelled" });
        // Allow re-entry if a fresh setup forms on the same level
        this.executedSetups.delete(trade.id);
        changed = true;
      }
    }

    // ── 2. Open positions that closed (SL/TP hit) ───────────────────────────
    for (const trade of openTrades) {
      if (openPositions.has(trade.symbol)) continue;

      // Position gone — cancel whichever order is still alive (the zombie).
      // The one we CAN cancel is the one that didn't fire.
      let closedByTP = false;

      if (trade.slOrderId !== undefined) {
        try {
          await cancelOrder(this.client, trade.symbol, trade.slOrderId, trade.slIsAlgo);
          closedByTP = true; // SL zombie cancelled → TP fired
        } catch {
          // SL already filled
        }
      }

      if (trade.tpOrderId !== undefined) {
        try {
          await cancelOrder(this.client, trade.symbol, trade.tpOrderId, trade.tpIsAlgo);
          closedByTP = false; // TP zombie cancelled → SL fired
        } catch {
          // TP already filled
        }
      }

      const closePrice  = closedByTP ? trade.takeProfit : trade.stopLoss;
      const pnlPerUnit  = trade.direction === "bull"
        ? closePrice - trade.entryPrice
        : trade.entryPrice - closePrice;

      this.trades.set(trade.id, {
        ...trade,
        status:        closedByTP ? "closed" : "stopped",
        closedAt:      Date.now(),
        closePrice,
        realizedPnl:   pnlPerUnit * trade.qty,
        unrealizedPnl: 0,
      });
      this.tradeMetrics.delete(trade.id);
      changed = true;
    }

    if (changed) {
      await this.refreshBalance();
      this.emit("update");
    }
  }

  // Places SL + TP for a trade that just filled (called from syncPositions).
  private async placeSLTP(trade: TradeRecord, fillPrice: number): Promise<void> {
    const closeSide = trade.direction === "bull" ? "SELL" : "BUY";

    let slOrderId: number | undefined;
    let slIsAlgo:  boolean | undefined;
    let tpOrderId: number | undefined;
    let tpIsAlgo:  boolean | undefined;

    try {
      const sl = await this.client.placeStopLoss(trade.symbol, closeSide, trade.qty, trade.stopLoss);
      slOrderId = sl.orderId;
      slIsAlgo  = sl.isAlgo;
    } catch (err) {
      console.error("[bot] SL order failed:", (err as Error).message);
    }

    try {
      const tp = await this.client.placeTakeProfit(trade.symbol, closeSide, trade.qty, trade.takeProfit);
      tpOrderId = tp.orderId;
      tpIsAlgo  = tp.isAlgo;
    } catch (err) {
      console.error("[bot] TP order failed:", (err as Error).message);
    }

    this.trades.set(trade.id, { ...trade, entryPrice: fillPrice, slOrderId, slIsAlgo, tpOrderId, tpIsAlgo });
  }

  // Places a GTC limit order at the OB edge (c2.close = garis merah):
  //   bull OB → limit BUY  at zoneBottom (last close before pump)
  //   bear OB → limit SELL at zoneTop    (last close before dump)
  // SL+TP are placed by syncPositions once Binance confirms the fill.
  private async executeLimitTrade(setup: ICTSetup, symbol: string): Promise<void> {
    if (!this.balance) throw new Error("No balance data");

    const [filters, maxLev] = await Promise.all([
      this.client.getSymbolFilters(symbol),
      this.client.getMaxLeverage(symbol),
    ]);
    const side = setup.direction === "bull" ? "BUY" : "SELL";

    // Entry at the OB edge = where line chart stopped before the impulse
    const limitPrice = setup.direction === "bull" ? setup.zoneBottom : setup.zoneTop;

    const riskPct = setup.confidence >= HIGH_CONF_THRESHOLD
      ? this.config.highRiskPct
      : this.config.riskPct;

    const qty = calcQty({
      balance: this.balance.availableBalance,
      riskPct,
      entryPrice: limitPrice,
      stopPrice:  setup.stop,
      leverage:   maxLev,
      stepSize:   filters.stepSize,
      minQty:     filters.minQty,
      minNotional: filters.minNotional,
    });

    if (qty <= 0) throw new Error("Calculated qty is 0");

    const limitOrder = await this.client.placeLimitOrder(symbol, side, qty, limitPrice);

    const key = `${symbol}::${setup.id}`;
    const poiStack = setup.poiStack.layers
      .map((l) => `${l.timeframe} ${l.kind}`)
      .join(" → ");

    this.trades.set(key, {
      id: key,
      symbol,
      direction:    setup.direction,
      entryPrice:   limitPrice,
      qty,
      stopLoss:     setup.stop,
      takeProfit:   setup.target,
      status:       "pending",
      unrealizedPnl: 0,
      openedAt:     Date.now(),
      setupId:      setup.id,
      setupType:    setup.type,
      confidence:   setup.confidence,
      leverage:     maxLev,
      riskPctUsed:  riskPct,
      riskPerUnit:  Math.abs(limitPrice - setup.stop),
      limitOrderId: limitOrder.orderId,
      reasons:      setup.reasons,
      poiStack,
    });

    this.balance = await this.client.getAccount();
    this.emit("update");
  }
}
