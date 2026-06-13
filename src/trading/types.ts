export interface BinancePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  positionSide: string;
  notional: string;
  isolatedWallet: string;
}

export interface BinanceOrder {
  orderId: number;
  symbol: string;
  status: string;
  side: "BUY" | "SELL";
  type: string;
  price: string;
  origQty: string;
  executedQty: string;
  reduceOnly: boolean;
  stopPrice: string;
  time: number;
}

export interface BinanceAccountBalance {
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  availableBalance: number;
}

export interface SymbolFilters {
  minQty: number;
  stepSize: number;
  tickSize: number;
  minNotional: number;
}

export type TradeStatus = "open" | "closed" | "stopped" | "failed";

export interface TradeRecord {
  id: string;
  symbol: string;
  direction: "bull" | "bear";
  entryPrice: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  status: TradeStatus;
  unrealizedPnl: number;
  openedAt: number;
  closedAt?: number;
  closePrice?: number;
  realizedPnl?: number;
  setupId: string;
  setupType: string;
  confidence: number;
  entryOrderId?: number;
  slOrderId?: number;
  tpOrderId?: number;
  slIsAlgo?: boolean;
  tpIsAlgo?: boolean;
  error?: string;
  reasons?: string[];
  poiStack?: string;   // compact label e.g. "1d OB → 4h FVG → 15m RBS"
}

export interface WatchedSymbol {
  symbol: string;
  price: number;
  setupCount: number;
  topConfidence: number;
  topSetupType: string;
  htfTrend: string;
  screenerRank: number; // 1-based rank from screener
}

export interface BotSnapshot {
  running: boolean;
  balance: BinanceAccountBalance | null;
  trades: TradeRecord[];
  lastError: string | null;
  lastUpdated: number;
  watchedSymbols: WatchedSymbol[];
}
