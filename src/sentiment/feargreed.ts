import type { FearGreedData } from "./types.ts";

interface FngResponse {
  data: Array<{ value: string; value_classification: string; timestamp: string }>;
}

export class FearGreedFetcher {
  private data: FearGreedData | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onUpdate: () => void;

  constructor(onUpdate: () => void) {
    this.onUpdate = onUpdate;
  }

  start() {
    this.fetch();
    this.timer = setInterval(() => this.fetch(), 10 * 60 * 1000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get(): FearGreedData | null {
    return this.data;
  }

  private async fetch() {
    try {
      const res = await fetch("https://api.alternative.me/fng/?limit=1", {
        signal: AbortSignal.timeout(8_000),
      });
      const json = (await res.json()) as FngResponse;
      const entry = json.data[0];
      if (!entry) return;
      this.data = {
        value: parseInt(entry.value),
        label: entry.value_classification,
        updatedAt: new Date(),
      };
      this.onUpdate();
    } catch {
      // silently retry next cycle
    }
  }
}
