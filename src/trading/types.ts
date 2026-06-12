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
  error?: string;
}

export interface BotSnapshot {
  running: boolean;
  balance: BinanceAccountBalance | null;
  trades: TradeRecord[];
  lastError: string | null;
  lastUpdated: number;
}
