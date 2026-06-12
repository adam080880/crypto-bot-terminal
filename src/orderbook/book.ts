export type Side = "bid" | "ask";

export interface Level {
  price: number;
  qty: number;
}

export class OrderBook {
  readonly bids = new Map<number, number>(); // price → qty, sorted desc on read
  readonly asks = new Map<number, number>(); // price → qty, sorted asc on read
  lastUpdateId = 0;

  applySnapshot(bids: Level[], asks: Level[]) {
    this.bids.clear();
    this.asks.clear();
    for (const { price, qty } of bids) {
      if (qty > 0) this.bids.set(price, qty);
    }
    for (const { price, qty } of asks) {
      if (qty > 0) this.asks.set(price, qty);
    }
  }

  applyDelta(bids: Level[], asks: Level[]) {
    for (const { price, qty } of bids) {
      if (qty === 0) this.bids.delete(price);
      else this.bids.set(price, qty);
    }
    for (const { price, qty } of asks) {
      if (qty === 0) this.asks.delete(price);
      else this.asks.set(price, qty);
    }
  }

  getTopBids(n: number): Level[] {
    return [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, n)
      .map(([price, qty]) => ({ price, qty }));
  }

  getTopAsks(n: number): Level[] {
    return [...this.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, n)
      .map(([price, qty]) => ({ price, qty }));
  }

  bestBid(): number | undefined {
    let best: number | undefined;
    for (const price of this.bids.keys()) {
      if (best === undefined || price > best) best = price;
    }
    return best;
  }

  bestAsk(): number | undefined {
    let best: number | undefined;
    for (const price of this.asks.keys()) {
      if (best === undefined || price < best) best = price;
    }
    return best;
  }

  spread(): number | undefined {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid === undefined || ask === undefined) return undefined;
    return ask - bid;
  }

  clear() {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateId = 0;
  }
}
