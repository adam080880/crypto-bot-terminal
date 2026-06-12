export const DEFAULT_SYMBOLS: readonly string[] = [
  "BTCUSDT",  "ETHUSDT",  "BNBUSDT",  "SOLUSDT",  "XRPUSDT",
  "ADAUSDT",  "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "LTCUSDT",  "UNIUSDT",  "ATOMUSDT", "NEARUSDT", "APTUSDT",
  "ARBUSDT",  "OPUSDT",   "INJUSDT",  "SUIUSDT",  "SEIUSDT",
  "TIAUSDT",  "WIFUSDT",  "JUPUSDT",  "FETUSDT",  "RENDERUSDT",
  "AAVEUSDT", "GMXUSDT",  "LDOUSDT",  "RUNEUSDT", "WLDUSDT",
] as const;

interface Ticker {
  symbol: string;
  quoteVolume: string;
}

export async function fetchTopSymbols(limit = 30): Promise<string[]> {
  try {
    const res = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tickers = (await res.json()) as Ticker[];
    return tickers
      .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("_"))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, limit)
      .map((t) => t.symbol);
  } catch {
    return [...DEFAULT_SYMBOLS].slice(0, limit);
  }
}
