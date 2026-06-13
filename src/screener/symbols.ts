export const DEFAULT_SYMBOLS: readonly string[] = [
  "BTCUSDT",   "ETHUSDT",   "BNBUSDT",   "SOLUSDT",   "XRPUSDT",
  "ADAUSDT",   "DOGEUSDT",  "AVAXUSDT",  "LINKUSDT",  "DOTUSDT",
  "LTCUSDT",   "UNIUSDT",   "ATOMUSDT",  "NEARUSDT",  "APTUSDT",
  "ARBUSDT",   "OPUSDT",    "INJUSDT",   "SUIUSDT",   "SEIUSDT",
  "TIAUSDT",   "WIFUSDT",   "JUPUSDT",   "FETUSDT",   "RENDERUSDT",
  "AAVEUSDT",  "GMXUSDT",   "LDOUSDT",   "RUNEUSDT",  "WLDUSDT",
  "STXUSDT",   "ORDIUSDT",  "PENDLEUSDT","PYTHUSDT",  "EIGENUSDT",
  "ENAUSDT",   "WUSDT",     "NOTUSDT",   "ZKUSDT",    "BBUSDT",
] as const;

interface ExchangeInfoSymbol {
  symbol: string;
  contractType: string;
  underlyingType: string;
  status: string;
}

interface Ticker {
  symbol: string;
  quoteVolume: string;
}

// Cache the allowed-symbol set for 1 hour — exchangeInfo rarely changes
let cryptoPerpCache: Set<string> | null = null;
let cryptoPerpCacheAt = 0;
const CACHE_TTL_MS = 60 * 60_000;

async function fetchCryptoPerpSymbols(): Promise<Set<string>> {
  if (cryptoPerpCache && Date.now() - cryptoPerpCacheAt < CACHE_TTL_MS) {
    return cryptoPerpCache;
  }
  const res = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
  if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
  const data = (await res.json()) as { symbols: ExchangeInfoSymbol[] };
  const allowed = new Set(
    data.symbols
      .filter(
        (s) =>
          s.underlyingType === "COIN" &&   // pure crypto only — excludes INDEX, COMMODITY
          s.contractType   === "PERPETUAL" && // no dated futures or TradFi perpetuals
          s.status         === "TRADING",
      )
      .map((s) => s.symbol),
  );
  cryptoPerpCache   = allowed;
  cryptoPerpCacheAt = Date.now();
  return allowed;
}

export async function fetchAllCryptoPerps(): Promise<string[]> {
  try {
    const [tickers, allowed] = await Promise.all([
      fetch("https://fapi.binance.com/fapi/v1/ticker/24hr")
        .then((r) => r.json() as Promise<Ticker[]>),
      fetchCryptoPerpSymbols(),
    ]);
    return tickers
      .filter((t) => allowed.has(t.symbol))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .map((t) => t.symbol);
  } catch {
    return [...DEFAULT_SYMBOLS];
  }
}
