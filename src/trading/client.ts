import { createHmac } from "crypto";
import type {
  BinancePosition,
  BinanceOrder,
  BinanceAccountBalance,
  SymbolFilters,
} from "./types.ts";

const BASE = "https://fapi.binance.com";

export class BinanceFuturesClient {
  private symbolFilterCache = new Map<string, SymbolFilters>();

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {}

  private sign(params: Record<string, string | number | boolean>): string {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString();
    const sig = createHmac("sha256", this.apiSecret).update(qs).digest("hex");
    return `${qs}&signature=${sig}`;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    const body = this.sign({ ...params, timestamp: Date.now() });
    const url = method === "GET" ? `${BASE}${path}?${body}` : `${BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "X-MBX-APIKEY": this.apiKey,
        ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(method !== "GET" ? { body } : {}),
    });
    const json = await res.json() as { code?: number; msg?: string } & T;
    if (!res.ok || (json.code !== undefined && json.code < 0)) {
      throw new Error(`Binance [${res.status}] ${json.msg ?? JSON.stringify(json)}`);
    }
    return json as T;
  }

  async ping(): Promise<boolean> {
    try {
      await this.request("GET", "/fapi/v2/account");
      return true;
    } catch {
      return false;
    }
  }

  async getAccount(): Promise<BinanceAccountBalance> {
    const data = await this.request<Record<string, string>>("GET", "/fapi/v2/account");
    return {
      totalWalletBalance: parseFloat(data.totalWalletBalance ?? "0"),
      totalUnrealizedProfit: parseFloat(data.totalUnrealizedProfit ?? "0"),
      totalMarginBalance: parseFloat(data.totalMarginBalance ?? "0"),
      availableBalance: parseFloat(data.availableBalance ?? "0"),
    };
  }

  async getPositions(symbol?: string): Promise<BinancePosition[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    const all = await this.request<BinancePosition[]>("GET", "/fapi/v2/positionRisk", params);
    return all.filter((p) => parseFloat(p.positionAmt) !== 0);
  }

  async getOpenOrders(symbol: string): Promise<BinanceOrder[]> {
    return this.request<BinanceOrder[]>("GET", "/fapi/v1/openOrders", { symbol });
  }

  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    qty: number,
  ): Promise<BinanceOrder> {
    const filters = await this.getSymbolFilters(symbol);
    const qtyStr = roundStep(qty, filters.stepSize);
    return this.request<BinanceOrder>("POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "MARKET",
      quantity: qtyStr,
    });
  }

  async placeStopLoss(
    symbol: string,
    side: "BUY" | "SELL",
    qty: number,
    stopPrice: number,
  ): Promise<BinanceOrder> {
    const filters = await this.getSymbolFilters(symbol);
    const qtyStr = roundStep(qty, filters.stepSize);
    const priceStr = roundStep(stopPrice, filters.tickSize);
    return this.request<BinanceOrder>("POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "STOP_MARKET",
      quantity: qtyStr,
      stopPrice: priceStr,
      reduceOnly: "true",
      workingType: "MARK_PRICE",
    });
  }

  async placeTakeProfit(
    symbol: string,
    side: "BUY" | "SELL",
    qty: number,
    stopPrice: number,
  ): Promise<BinanceOrder> {
    const filters = await this.getSymbolFilters(symbol);
    const qtyStr = roundStep(qty, filters.stepSize);
    const priceStr = roundStep(stopPrice, filters.tickSize);
    return this.request<BinanceOrder>("POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "TAKE_PROFIT_MARKET",
      quantity: qtyStr,
      stopPrice: priceStr,
      reduceOnly: "true",
      workingType: "MARK_PRICE",
    });
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    await this.request("DELETE", "/fapi/v1/order", { symbol, orderId });
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.request("POST", "/fapi/v1/leverage", { symbol, leverage });
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    const cached = this.symbolFilterCache.get(symbol);
    if (cached) return cached;

    const info = await fetch(`${BASE}/fapi/v1/exchangeInfo?symbol=${symbol}`).then(
      (r) => r.json() as Promise<{ symbols: Array<{ symbol: string; filters: Array<{ filterType: string; [k: string]: string }> }> }>
    );
    const sym = info.symbols.find((s) => s.symbol === symbol);
    if (!sym) throw new Error(`Symbol ${symbol} not found in exchange info`);

    const lot = sym.filters.find((f) => f.filterType === "LOT_SIZE");
    const price = sym.filters.find((f) => f.filterType === "PRICE_FILTER");
    const minNotional = sym.filters.find((f) => f.filterType === "MIN_NOTIONAL");

    const filters: SymbolFilters = {
      minQty: parseFloat(lot?.minQty ?? "0.001"),
      stepSize: parseFloat(lot?.stepSize ?? "0.001"),
      tickSize: parseFloat(price?.tickSize ?? "0.1"),
      minNotional: parseFloat(minNotional?.notional ?? "5"),
    };
    this.symbolFilterCache.set(symbol, filters);
    return filters;
  }
}

function roundStep(value: number, step: number): string {
  const decimals = step.toString().split(".")[1]?.length ?? 0;
  const rounded = Math.floor(value / step) * step;
  return rounded.toFixed(decimals);
}
