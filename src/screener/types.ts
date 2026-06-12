import type { ICTSetup, Trend } from "../ict/types.ts";

export interface ScreenerResult {
  symbol: string;
  price: number;
  htfTrend: Trend;
  setups: ICTSetup[];
  scannedAt: number;
  error?: string;
}

export interface ScreenerSnapshot {
  results: ScreenerResult[];
  scanning: boolean;
  lastScanAt: number;
  progress: { done: number; total: number };
}
