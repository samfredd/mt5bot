import type { Candle, Tick } from "../mt5/client.js";
import { atr, bollinger, ema, last, macd, rsi, sma } from "./indicators.js";

export interface TimeframeAnalysis {
  timeframe: string;
  trend: "bullish" | "bearish" | "ranging";
  rsi: number | null;
  macdHistogram: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  bollingerPosition: "above_upper" | "below_lower" | "inside" | null;
  atr: number | null;
  atrPct: number | null;
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
}

export function detectSession(now = new Date()): string {
  const h = now.getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  if (h >= 7 && h < 12) return "london";
  if (h >= 12 && h < 16) return "london_newyork_overlap";
  if (h >= 16 && h < 21) return "newyork";
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
  const { histogram } = macd(closes);
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
    macdHistogram: last(histogram) ?? null,
    emaFast: eFast,
    emaSlow: eSlow,
    bollingerPosition,
    atr: lastAtr,
    atrPct: lastAtr !== null && lastClose ? (lastAtr / lastClose) * 100 : null,
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
  return {
    symbol,
    generatedAt: new Date().toISOString(),
    spreadPoints: tick.spread_points,
    bid: tick.bid,
    ask: tick.ask,
    session: detectSession(),
    timeframes,
    summary: `Trends — ${trends}. Spread ${tick.spread_points} points. Session: ${detectSession()}.`,
  };
}
