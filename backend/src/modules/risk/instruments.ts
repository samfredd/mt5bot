/**
 * Instrument metadata + value-per-point, the missing piece that makes
 * position sizing and the per-trade risk cap correct across the whole
 * traded universe — not just 5-digit USD-quoted FX pairs.
 *
 * Pure (no I/O) so it can be unit-tested exhaustively and used inside the
 * risk engine and the backtester without changing their I/O-free contract.
 */

export type InstrumentKind = "fx" | "metal" | "index" | "crypto" | "other";

export interface InstrumentSpec {
  symbol: string;
  /** Units of the underlying per 1.0 lot. */
  contractSize: number;
  /** Currency the trade is denominated in (the base of an FX pair). */
  baseCurrency: string | null;
  /** Currency the PRICE is quoted in. */
  quoteCurrency: string;
  kind: InstrumentKind;
}

const KNOWN_CCY = ["EUR", "USD", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "CNY"];

const METAL_CONTRACT: Record<string, number> = { XAU: 100, XAG: 5000, XPT: 100, XPD: 100 };
const CRYPTO_BASES = ["BTC", "ETH", "LTC", "XRP", "BCH", "ADA", "SOL", "DOGE", "DOT", "LINK"];

/**
 * Static fallback quote→USD rates, used ONLY for non-USD cross pairs
 * (e.g. EURGBP, GBPJPY). The bot's core universe — USD majors, metals,
 * indices, crypto — is converted exactly via the live price, so these
 * approximations only ever affect peripheral instruments. They are
 * intentionally conservative ballpark figures, not live rates.
 */
const APPROX_USD_PER_UNIT: Record<string, number> = {
  USD: 1, EUR: 1.08, GBP: 1.27, AUD: 0.66, NZD: 0.6,
  CAD: 0.73, CHF: 1.1, JPY: 1 / 151, CNY: 0.14,
};

/**
 * Classify a broker symbol, tolerating BOTH separator suffixes (`EURUSD.m`,
 * `XAUUSD-ECN`) and bare appended tags (`EURUSDm`, `XAUUSDc`) that brokers
 * like Exness use. We match the leading "core" of the symbol rather than
 * requiring an exact length, and validate the quote currency against the
 * known set so a trailing tag never poisons the conversion.
 */
export function classifyInstrument(symbol: string): InstrumentSpec {
  const s = symbol.toUpperCase().replace(/[._-].*$/, "");
  const knownQuote = (q: string) => (KNOWN_CCY.includes(q) ? q : "USD");

  for (const metal of Object.keys(METAL_CONTRACT)) {
    if (s.startsWith(metal)) {
      return { symbol, contractSize: METAL_CONTRACT[metal], baseCurrency: metal, quoteCurrency: knownQuote(s.slice(3, 6)), kind: "metal" };
    }
  }

  for (const crypto of CRYPTO_BASES) {
    if (s.startsWith(crypto)) {
      return { symbol, contractSize: 1, baseCurrency: crypto, quoteCurrency: knownQuote(s.slice(crypto.length, crypto.length + 3)), kind: "crypto" };
    }
  }

  // FX: the first 6 chars are two known currencies — covers EURUSD, EURUSDm,
  // EURUSD.r, etc. without mistaking a trailing tag for the quote.
  const core = s.slice(0, 6);
  if (/^[A-Z]{6}$/.test(core)) {
    const base = core.slice(0, 3);
    const quote = core.slice(3);
    if (KNOWN_CCY.includes(base) && KNOWN_CCY.includes(quote)) {
      return { symbol, contractSize: 100_000, baseCurrency: base, quoteCurrency: quote, kind: "fx" };
    }
  }

  // Indices (US30, NAS100, …) and anything unrecognized: priced in USD,
  // 1 unit per lot so a 1.0 price move is worth $1 per lot.
  return { symbol, contractSize: 1, baseCurrency: null, quoteCurrency: "USD", kind: "index" };
}

/**
 * USD value of a 1.0 price-unit move for 1.0 lot — the conversion factor that
 * turns a stop *distance in price* into *money at risk*.
 *
 *   P&L (quote currency) = priceMove × contractSize  →  convert quote → USD:
 *     • quote = USD              → ×1            (EURUSD, XAUUSD, US30, BTCUSD)
 *     • USD-based pair (USDxxx)  → ÷ price        (USDJPY, USDCAD, USDCHF)
 *     • other (crosses)          → static approx  (EURGBP, GBPJPY …)
 *
 * Assumes a USD-denominated account, which matches this platform's setup.
 */
export function valuePerPointPerLot(symbol: string, price: number): number {
  const spec = classifyInstrument(symbol);
  let quoteToUsd: number;
  if (spec.quoteCurrency === "USD") {
    quoteToUsd = 1;
  } else if (spec.baseCurrency === "USD" && price > 0) {
    quoteToUsd = 1 / price;
  } else {
    quoteToUsd = APPROX_USD_PER_UNIT[spec.quoteCurrency] ?? 1;
  }
  return spec.contractSize * quoteToUsd;
}
