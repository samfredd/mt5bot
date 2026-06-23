import type { Candle, Tick } from "../mt5/client.js";
import { adx, atr, bollinger, ema, last, macd, rsi, sma } from "./indicators.js";

export interface TimeframeAnalysis {
  timeframe: string;
  trend: "bullish" | "bearish" | "ranging";
  rsi: number | null;
  rsiPrevious: number | null;
  macdHistogram: number | null;
  macdPrevious: number | null;
  macdCurrent: number | null;
  signalPrevious: number | null;
  signalCurrent: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  bollingerPosition: "above_upper" | "below_lower" | "inside" | null;
  atr: number | null;
  atrPct: number | null;
  /** Trend strength (Wilder ADX); low = ranging, high = strong trend. */
  adx: number | null;
  support: number | null;
  resistance: number | null;
  lastClose: number | null;
  candlePattern: string | null;
  structure: "higher_highs" | "lower_lows" | "consolidation";
}

export interface MarketAnalysis {
  symbol: string;
  generatedAt: string;
  spreadPoints: number;
  bid: number;
  ask: number;
  session: string;
  timeframes: TimeframeAnalysis[];
  summary: string;
  /** High/low of today's completed Asian session (for London breakouts). */
  referenceRange: { high: number; low: number } | null;
}

/**
 * High/low of today's completed Asian session (00:00–07:00 UTC) from the
 * given candles. Null until that session has closed — so a London-session
 * breakout has a defined level to trade against.
 */
export function asianRange(candles: Candle[], nowMs: number): { high: number; low: number } | null {
  const now = new Date(nowMs);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const asianEnd = dayStart + 7 * 3600_000;
  if (nowMs < asianEnd) return null; // Asian session not finished yet today
  let high = -Infinity;
  let low = Infinity;
  let count = 0;
  for (const c of candles) {
    const t = new Date(c.time).getTime();
    if (t >= dayStart && t < asianEnd) { high = Math.max(high, c.high); low = Math.min(low, c.low); count++; }
  }
  return count >= 2 ? { high, low } : null;
}

export function detectSession(now = new Date()): string {
  const localHour = (timeZone: string) => {
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now).find((part) => part.type === "hour")?.value;
    return Number(hour ?? -1);
  };
  const londonHour = localHour("Europe/London");
  const newYorkHour = localHour("America/New_York");
  const londonOpen = londonHour >= 8 && londonHour < 17;
  const newYorkOpen = newYorkHour >= 8 && newYorkHour < 17;
  if (londonOpen && newYorkOpen) return "london_newyork_overlap";
  if (londonOpen) return "london";
  if (newYorkOpen) return "newyork";
  const h = now.getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  return "sydney";
}

function swingLevels(candles: Candle[], lookback = 50) {
  const recent = candles.slice(-lookback);
  const lows = recent.map((c) => c.low);
  const highs = recent.map((c) => c.high);
  return { support: Math.min(...lows), resistance: Math.max(...highs) };
}

function detectPattern(candles: Candle[]): string | null {
  if (candles.length < 2) return null;
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return null;
  if (body / range < 0.1) return "doji";
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  if (lowerWick > body * 2 && upperWick < body) return "hammer";
  if (upperWick > body * 2 && lowerWick < body) return "shooting_star";
  if (c.close > c.open && p.close < p.open && c.close > p.open && c.open < p.close)
    return "bullish_engulfing";
  if (c.close < c.open && p.close > p.open && c.close < p.open && c.open > p.close)
    return "bearish_engulfing";
  return null;
}

function detectStructure(candles: Candle[]): TimeframeAnalysis["structure"] {
  const recent = candles.slice(-30);
  if (recent.length < 10) return "consolidation";
  const half = Math.floor(recent.length / 2);
  const firstHigh = Math.max(...recent.slice(0, half).map((c) => c.high));
  const secondHigh = Math.max(...recent.slice(half).map((c) => c.high));
  const firstLow = Math.min(...recent.slice(0, half).map((c) => c.low));
  const secondLow = Math.min(...recent.slice(half).map((c) => c.low));
  if (secondHigh > firstHigh && secondLow > firstLow) return "higher_highs";
  if (secondHigh < firstHigh && secondLow < firstLow) return "lower_lows";
  return "consolidation";
}

export function analyzeTimeframe(timeframe: string, candles: Candle[]): TimeframeAnalysis {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const emaFastArr = ema(closes, 20);
  const emaSlowArr = ema(closes, 50);
  const rsiArr = rsi(closes, 14);
  const { macdLine, signalLine, histogram } = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const atrArr = atr(highs, lows, closes, 14);
  const { support, resistance } = swingLevels(candles);

  const lastClose = last(closes) ?? null;
  const eFast = last(emaFastArr) ?? null;
  const eSlow = last(emaSlowArr) ?? null;
  const lastAtr = last(atrArr) ?? null;
  const bbUpper = last(bb.upper);
  const bbLower = last(bb.lower);

  let trend: TimeframeAnalysis["trend"] = "ranging";
  if (eFast !== null && eSlow !== null && lastClose !== null) {
    if (eFast > eSlow && lastClose > eFast) trend = "bullish";
    else if (eFast < eSlow && lastClose < eFast) trend = "bearish";
  }

  let bollingerPosition: TimeframeAnalysis["bollingerPosition"] = null;
  if (lastClose !== null && bbUpper !== undefined && bbLower !== undefined) {
    bollingerPosition =
      lastClose > bbUpper ? "above_upper" : lastClose < bbLower ? "below_lower" : "inside";
  }

  return {
    timeframe,
    trend,
    rsi: last(rsiArr) ?? null,
    rsiPrevious: rsiArr.at(-2) ?? null,
    macdHistogram: last(histogram) ?? null,
    macdPrevious: macdLine.at(-2) ?? null,
    macdCurrent: last(macdLine) ?? null,
    signalPrevious: signalLine.at(-2) ?? null,
    signalCurrent: last(signalLine) ?? null,
    emaFast: eFast,
    emaSlow: eSlow,
    bollingerPosition,
    atr: lastAtr,
    atrPct: lastAtr !== null && lastClose ? (lastAtr / lastClose) * 100 : null,
    adx: last(adx(highs, lows, closes, 14)) ?? null,
    support,
    resistance,
    lastClose,
    candlePattern: detectPattern(candles),
    structure: detectStructure(candles),
  };
}

export function buildMarketAnalysis(
  symbol: string,
  tick: Tick,
  candlesByTf: Record<string, Candle[]>,
): MarketAnalysis {
  const timeframes = Object.entries(candlesByTf).map(([tf, candles]) =>
    analyzeTimeframe(tf, candles),
  );
  const trends = timeframes.map((t) => `${t.timeframe}:${t.trend}`).join(", ");
  const primaryCandles = Object.values(candlesByTf)[0] ?? [];
  return {
    symbol,
    generatedAt: new Date().toISOString(),
    spreadPoints: tick.spread_points,
    bid: tick.bid,
    ask: tick.ask,
    session: detectSession(),
    timeframes,
    summary: `Trends — ${trends}. Spread ${tick.spread_points} points. Session: ${detectSession()}.`,
    referenceRange: asianRange(primaryCandles, Date.now()),
  };
}
