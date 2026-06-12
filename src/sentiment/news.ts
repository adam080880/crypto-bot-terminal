import type { NewsItem } from "./types.ts";

// ── Keyword sentiment dict ────────────────────────────────────────────────────

const POSITIVE = new Set([
  "bull", "bullish", "surge", "surges", "rally", "rallies", "breakout", "moon",
  "pump", "pumps", "ath", "all-time high", "adoption", "rise", "rises", "gain",
  "gains", "soar", "soars", "record", "milestone", "approval", "approved",
  "institutional", "buy", "buying", "long", "inflow", "inflows", "etf",
  "upgrade", "partnership", "launch", "launches", "expansion", "growth",
  "recover", "recovery", "strong", "strength", "positive", "optimistic",
]);

const NEGATIVE = new Set([
  "bear", "bearish", "crash", "crashes", "dump", "dumps", "hack", "hacked",
  "ban", "banned", "regulation", "regulations", "regulated", "fud", "fear",
  "sell", "selling", "short", "plunge", "plunges", "tumble", "tumbles",
  "fall", "falls", "decline", "declines", "warning", "risk", "risks",
  "scam", "fraud", "lawsuit", "charges", "arrest", "seized", "liquidation",
  "liquidations", "outflow", "outflows", "withdraw", "withdrawal", "collapse",
  "collapses", "exploit", "vulnerability", "fine", "penalty", "shutdown",
]);

function keywordScore(text: string): number {
  const words = text.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/\s+/);
  let pos = 0, neg = 0;
  for (const w of words) {
    if (POSITIVE.has(w)) pos++;
    if (NEGATIVE.has(w)) neg++;
  }
  const total = pos + neg;
  if (total === 0) return 0;
  return (pos - neg) / total;
}

// ── Minimal RSS XML parser ────────────────────────────────────────────────────

function extractTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]!.replace(/<!\[CDATA\[|\]\]>/g, "").trim());
  }
  return results;
}

function parseRss(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1]!;
    const title = extractTags(block, "title")[0] ?? "";
    const link = extractTags(block, "link")[0] ?? extractTags(block, "guid")[0] ?? "";
    const pubDate = extractTags(block, "pubDate")[0] ?? extractTags(block, "dc:date")[0] ?? "";
    if (!title) continue;
    items.push({
      title,
      url: link,
      source,
      publishedAt: pubDate ? new Date(pubDate) : new Date(),
      score: keywordScore(title),
      scoredBy: "keyword",
    });
  }
  return items;
}

// ── RSS feeds ────────────────────────────────────────────────────────────────

const RSS_FEEDS: { url: string; source: string }[] = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", source: "CoinTelegraph" },
  { url: "https://decrypt.co/feed", source: "Decrypt" },
];

async function fetchRss(url: string, source: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; trading-terminal/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    const xml = await res.text();
    return parseRss(xml, source);
  } catch {
    return [];
  }
}

// ── CryptoPanic (optional, needs CRYPTOPANIC_TOKEN) ──────────────────────────

interface CpPost {
  title: string;
  url: string;
  published_at: string;
  votes: { positive: number; negative: number; important: number };
  source: { title: string };
}

async function fetchCryptoPanic(token: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(
      `https://cryptopanic.com/api/v1/posts/?auth_token=${token}&currencies=BTC&filter=hot&public=true`,
      { signal: AbortSignal.timeout(10_000) }
    );
    const json = (await res.json()) as { results: CpPost[] };
    return (json.results ?? []).map((p) => {
      const total = p.votes.positive + p.votes.negative;
      const score = total > 0 ? (p.votes.positive - p.votes.negative) / total : 0;
      return {
        title: p.title,
        url: p.url,
        source: `CryptoPanic/${p.source.title}`,
        publishedAt: new Date(p.published_at),
        score,
        scoredBy: "votes" as const,
      };
    });
  } catch {
    return [];
  }
}

// ── LLM scoring (optional, needs ANTHROPIC_API_KEY) ──────────────────────────

interface AnthropicMsg {
  content: Array<{ type: string; text: string }>;
}

const llmCache = new Map<string, { score: number; ts: number }>();
const LLM_CACHE_MS = 5 * 60 * 1000;

async function scoreBatchWithLLM(titles: string[]): Promise<number[]> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || titles.length === 0) return titles.map(() => 0);

  // check cache first
  const uncached: number[] = [];
  const cachedScores: (number | null)[] = titles.map((t) => {
    const hit = llmCache.get(t);
    if (hit && Date.now() - hit.ts < LLM_CACHE_MS) return hit.score;
    uncached.push(titles.indexOf(t));
    return null;
  });

  if (uncached.length === 0) return cachedScores.map((s) => s ?? 0);

  const toScore = uncached.map((i) => titles[i]!);
  const prompt = `Rate each crypto news headline sentiment from -1.0 (very bearish) to +1.0 (very bullish). Reply ONLY with a JSON array of numbers, one per headline, in order.

Headlines:
${toScore.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as AnthropicMsg;
    const text = json.content[0]?.text ?? "[]";
    const scores = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as number[];

    uncached.forEach((origIdx, i) => {
      const score = Math.max(-1, Math.min(1, scores[i] ?? 0));
      llmCache.set(titles[origIdx]!, { score, ts: Date.now() });
      cachedScores[origIdx] = score;
    });
  } catch {
    uncached.forEach((origIdx) => { cachedScores[origIdx] = 0; });
  }

  return cachedScores.map((s) => s ?? 0);
}

// ── Main NewsFetcher ──────────────────────────────────────────────────────────

export class NewsFetcher {
  private items: NewsItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private onUpdate: () => void;
  private useLLM = !!process.env["ANTHROPIC_API_KEY"];
  private cpToken = process.env["CRYPTOPANIC_TOKEN"] ?? "";

  constructor(onUpdate: () => void) {
    this.onUpdate = onUpdate;
  }

  start() {
    this.fetch();
    this.timer = setInterval(() => this.fetch(), 5 * 60 * 1000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get(): NewsItem[] {
    return this.items;
  }

  private async fetch() {
    const promises: Promise<NewsItem[]>[] = RSS_FEEDS.map((f) => fetchRss(f.url, f.source));
    if (this.cpToken) promises.push(fetchCryptoPanic(this.cpToken));

    const results = await Promise.allSettled(promises);
    let all: NewsItem[] = results
      .filter((r): r is PromiseFulfilledResult<NewsItem[]> => r.status === "fulfilled")
      .flatMap((r) => r.value);

    // deduplicate by title similarity
    const seen = new Set<string>();
    all = all.filter((item) => {
      const key = item.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // sort by recency
    all.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    const top = all.slice(0, 15);

    // optionally rescore with LLM
    if (this.useLLM) {
      const keywordOnly = top.filter((i) => i.scoredBy === "keyword");
      if (keywordOnly.length > 0) {
        const scores = await scoreBatchWithLLM(keywordOnly.map((i) => i.title));
        keywordOnly.forEach((item, idx) => {
          item.score = scores[idx]!;
          item.scoredBy = "llm";
        });
      }
    }

    this.items = top.slice(0, 10);
    this.onUpdate();
  }
}
