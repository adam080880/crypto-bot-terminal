import { EventEmitter } from "events";
import type { SentimentSnapshot } from "./types.ts";
import { FearGreedFetcher } from "./feargreed.ts";
import { NewsFetcher } from "./news.ts";
import { FundingFetcher } from "./funding.ts";

export class SentimentAggregator extends EventEmitter {
  private fearGreed: FearGreedFetcher;
  private news: NewsFetcher;
  private funding: FundingFetcher;
  private snapshot: SentimentSnapshot = {
    fearGreed: null,
    funding: [],
    longShort: [],
    news: [],
    overallScore: 0,
    updatedAt: new Date(),
  };

  constructor() {
    super();
    const notify = () => { this.recompute(); this.emit("update"); };
    this.fearGreed = new FearGreedFetcher(notify);
    this.news = new NewsFetcher(notify);
    this.funding = new FundingFetcher(notify);
  }

  start(symbol: string) {
    this.fearGreed.start();
    this.news.start();
    this.funding.start(symbol);
  }

  stop() {
    this.fearGreed.stop();
    this.news.stop();
    this.funding.stop();
  }

  get(): SentimentSnapshot {
    return this.snapshot;
  }

  private recompute() {
    const fg = this.fearGreed.get();
    const newsItems = this.news.get();
    const fundingEntries = this.funding.getFunding();
    const lsEntries = this.funding.getLongShort();

    // fear & greed: normalize 0–100 → -1 to +1
    const fgScore = fg ? (fg.value - 50) / 50 : 0;
    const fgWeight = fg ? 0.2 : 0;

    // news: average score of top 10
    const newsScore = newsItems.length > 0
      ? newsItems.reduce((s, n) => s + n.score, 0) / newsItems.length
      : 0;
    const newsWeight = newsItems.length > 0 ? 0.5 : 0;

    // funding: positive rate = bullish (traders pay long), normalize per exchange
    // typical range: -0.001 to +0.001 per 8h → map to -1 to +1
    const fundingScore = fundingEntries.length > 0
      ? fundingEntries.reduce((s, f) => s + Math.tanh(f.rate * 5000), 0) / fundingEntries.length
      : 0;

    // long/short: ratio > 1.2 = bullish, < 0.8 = bearish
    const lsScore = lsEntries.length > 0
      ? lsEntries.reduce((s, l) => s + Math.tanh((l.ratio - 1) * 2), 0) / lsEntries.length
      : 0;

    const fundingLsWeight = (fundingEntries.length > 0 || lsEntries.length > 0) ? 0.3 : 0;
    const fundingLsCombined = fundingEntries.length + lsEntries.length > 0
      ? (fundingScore + lsScore) / 2
      : 0;

    const totalWeight = fgWeight + newsWeight + fundingLsWeight;
    const overall = totalWeight > 0
      ? (fgScore * fgWeight + newsScore * newsWeight + fundingLsCombined * fundingLsWeight) / totalWeight
      : 0;

    this.snapshot = {
      fearGreed: fg,
      funding: fundingEntries,
      longShort: lsEntries,
      news: newsItems,
      overallScore: Math.max(-1, Math.min(1, overall)),
      updatedAt: new Date(),
    };
  }
}
