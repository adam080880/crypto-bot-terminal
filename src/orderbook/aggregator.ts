import { EventEmitter } from "events";
import { OrderBook } from "./book.ts";
import type { BaseCrawler, CrawlerStatus } from "../crawlers/base.ts";

export const EXCHANGES = ["BNC", "BYB", "OKX", "BGX", "BGT", "GAT", "HYP"] as const;
export type ExchangeId = (typeof EXCHANGES)[number];

export interface AggregatedLevel {
  price: number;
  totalQty: number;
  perExchange: Partial<Record<ExchangeId, number>>;
}

export interface AggregatedBook {
  asks: AggregatedLevel[]; // sorted asc
  bids: AggregatedLevel[]; // sorted desc
  bestSpread: { exchange: ExchangeId; value: number } | undefined;
  aggSpread: number | undefined;
  statuses: Record<ExchangeId, CrawlerStatus>;
}

export class Aggregator extends EventEmitter {
  private books = new Map<ExchangeId, OrderBook>();
  private statuses: Record<ExchangeId, CrawlerStatus> = {
    BNC: "connecting",
    BYB: "connecting",
    OKX: "connecting",
    BGX: "connecting",
    BGT: "connecting",
    GAT: "connecting",
    HYP: "connecting",
  };

  constructor(crawlers: BaseCrawler[]) {
    super();
    for (const crawler of crawlers) {
      const id = crawler.exchange as ExchangeId;
      this.books.set(id, new OrderBook());

      crawler.on("snapshot", ({ exchange, bids, asks }) => {
        this.books.get(exchange as ExchangeId)?.applySnapshot(bids, asks);
        this.emit("update");
      });

      crawler.on("delta", ({ exchange, bids, asks }) => {
        this.books.get(exchange as ExchangeId)?.applyDelta(bids, asks);
        this.emit("update");
      });

      crawler.on("status", ({ exchange, status }) => {
        const exId = exchange as ExchangeId;
        this.statuses[exId] = status;
        if (status === "disconnected" || status === "error") {
          this.books.get(exId)?.clear();
        }
        this.emit("update");
      });
    }
  }

  getBook(depth = 20, tickSize = 1): AggregatedBook {
    const bucket = (price: number, side: "bid" | "ask"): number => {
      if (tickSize <= 0) return price;
      return side === "bid"
        ? Math.floor(price / tickSize) * tickSize
        : Math.ceil(price / tickSize) * tickSize;
    };

    const buildSide = (side: "bid" | "ask"): AggregatedLevel[] => {
      // bucket → { perExchange, totalQty }
      const buckets = new Map<number, { perExchange: Partial<Record<ExchangeId, number>>; totalQty: number }>();

      for (const [exId, book] of this.books) {
        const map = side === "bid" ? book.bids : book.asks;
        for (const [price, qty] of map) {
          if (qty <= 0) continue;
          const key = bucket(price, side);
          let entry = buckets.get(key);
          if (!entry) { entry = { perExchange: {}, totalQty: 0 }; buckets.set(key, entry); }
          entry.perExchange[exId] = (entry.perExchange[exId] ?? 0) + qty;
          entry.totalQty += qty;
        }
      }

      return [...buckets.entries()].map(([price, { perExchange, totalQty }]) => ({
        price, totalQty, perExchange,
      }));
    };

    const asks = buildSide("ask")
      .sort((a, b) => a.price - b.price)
      .slice(0, depth);

    const bids = buildSide("bid")
      .sort((a, b) => b.price - a.price)
      .slice(0, depth);


    // best spread = tightest single-exchange spread
    let bestSpread: AggregatedBook["bestSpread"];
    for (const [exId, book] of this.books) {
      const s = book.spread();
      if (s !== undefined && (bestSpread === undefined || s < bestSpread.value)) {
        bestSpread = { exchange: exId as ExchangeId, value: s };
      }
    }

    // aggregated spread = best ask across all vs best bid across all
    const topAsk = asks[0]?.price;
    const topBid = bids[0]?.price;
    const aggSpread = topAsk !== undefined && topBid !== undefined ? topAsk - topBid : undefined;

    return { asks, bids, bestSpread, aggSpread, statuses: { ...this.statuses } };
  }

  getMidPrice(): number | undefined {
    let bestAsk: number | undefined;
    let bestBid: number | undefined;
    for (const book of this.books.values()) {
      const bid = book.bestBid();
      const ask = book.bestAsk();
      if (bid !== undefined && (bestBid === undefined || bid > bestBid)) bestBid = bid;
      if (ask !== undefined && (bestAsk === undefined || ask < bestAsk)) bestAsk = ask;
    }
    if (bestBid === undefined || bestAsk === undefined) return undefined;
    return (bestBid + bestAsk) / 2;
  }
}
