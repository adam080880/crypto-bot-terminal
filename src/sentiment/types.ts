export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: Date;
  score: number;        // -1.0 to +1.0
  scoredBy: "keyword" | "llm" | "votes";
}

export interface FearGreedData {
  value: number;        // 0–100
  label: string;        // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  updatedAt: Date;
}

export interface FundingEntry {
  exchange: string;
  rate: number;         // e.g. 0.0001 = 0.01%
  nextFundingTime: Date | null;
}

export interface LongShortEntry {
  exchange: string;
  ratio: number;        // longAccounts / shortAccounts, >1 means longs dominate
}

export interface SentimentSnapshot {
  fearGreed: FearGreedData | null;
  funding: FundingEntry[];
  longShort: LongShortEntry[];
  news: NewsItem[];
  overallScore: number;   // weighted avg: feargreed(0.2) + funding(0.3) + news(0.5)
  updatedAt: Date;
}
