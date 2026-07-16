import type { Candle } from "../mt5/client.js";
import { adx, atr, ema, last, macd, rsi, sma } from "./indicators.js";

/**
 * Pure feature extraction: turns raw candles into the high-signal reads the
 * LLM payload is built from (structure, momentum, volume, volatility, trend).
 * No I/O, no side effects — every function degrades to nulls on short input
 * instead of throwing, because callers may hold as few as a handful of bars.
 */

export interface SwingPoint {
  index: number;
  price: number;
  kind: "high" | "low";
}

/** Fractal pivots: a high/low strictly above/below the k bars on each side. */
export function detectSwings(candles: Candle[], k = 2): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ index: i, price: candles[i].high, kind: "high" });
    if (isLow) swings.push({ index: i, price: candles[i].low, kind: "low" });
  }
  return swings;
}

export interface StructureRead {
  status: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** Recent break of structure WITH the prevailing trend (close beyond the last swing extreme). */
  bos: boolean;
  /** Change of character: close broke the last swing extreme AGAINST the prior structure. */
  choch: boolean;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
}

function structureStatus(highs: SwingPoint[], lows: SwingPoint[]): StructureRead["status"] {
  if (highs.length < 2 || lows.length < 2) return "NEUTRAL";
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  if (hh && hl) return "BULLISH";
  if (!hh && !hl) return "BEARISH";
  return "NEUTRAL";
}

export function readStructure(candles: Candle[], swings: SwingPoint[] = detectSwings(candles)): StructureRead {
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const lastClose = candles[candles.length - 1]?.close ?? null;
  const lastSwingHigh = highs[highs.length - 1]?.price ?? null;
  const lastSwingLow = lows[lows.length - 1]?.price ?? null;
  const status = structureStatus(highs, lows);
  // Structure as it read BEFORE the most recent swing formed — the reference
  // for "character change" (a break against what the market had been doing).
  const prevStatus = structureStatus(highs.slice(0, -1), lows.slice(0, -1));

  let bos = false;
  let choch = false;
  if (lastClose !== null) {
    bos =
      (status === "BULLISH" && lastSwingHigh !== null && lastClose > lastSwingHigh) ||
      (status === "BEARISH" && lastSwingLow !== null && lastClose < lastSwingLow);
    choch =
      (prevStatus === "BULLISH" && lastSwingLow !== null && lastClose < lastSwingLow) ||
      (prevStatus === "BEARISH" && lastSwingHigh !== null && lastClose > lastSwingHigh);
  }
  return { status, bos, choch, lastSwingHigh, lastSwingLow };
}

export interface PriceLevel {
  price: number;
  touches: number;
}

/**
 * Cluster swing prices into levels (tolerance ≈ half an ATR) and split into
 * support (below price) / resistance (above), strongest-and-nearest first.
 */
export function keyLevels(
  candles: Candle[],
  swings: SwingPoint[],
  tolerance: number,
  maxPerSide = 3,
): { support: PriceLevel[]; resistance: PriceLevel[] } {
  const lastClose = candles[candles.length - 1]?.close;
  if (lastClose === undefined || swings.length === 0 || tolerance <= 0) {
    return { support: [], resistance: [] };
  }
  const prices = swings.map((s) => s.price).sort((a, b) => a - b);
  const clusters: PriceLevel[] = [];
  let bucket: number[] = [prices[0]];
  for (let i = 1; i <= prices.length; i++) {
    if (i < prices.length && prices[i] - bucket[bucket.length - 1] <= tolerance) {
      bucket.push(prices[i]);
    } else {
      clusters.push({ price: bucket.reduce((a, b) => a + b, 0) / bucket.length, touches: bucket.length });
      if (i < prices.length) bucket = [prices[i]];
    }
  }
  const rank = (a: PriceLevel, b: PriceLevel) =>
    b.touches - a.touches || Math.abs(a.price - lastClose) - Math.abs(b.price - lastClose);
  return {
    support: clusters.filter((c) => c.price < lastClose).sort(rank).slice(0, maxPerSide),
    resistance: clusters.filter((c) => c.price > lastClose).sort(rank).slice(0, maxPerSide),
  };
}

export interface LiquidityPool {
  side: "above" | "below";
  price: number;
  touches: number;
}

/** Equal highs above price / equal lows below — resting-stop clusters. */
export function liquidityPools(candles: Candle[], swings: SwingPoint[], tolerance: number): LiquidityPool[] {
  const lastClose = candles[candles.length - 1]?.close;
  if (lastClose === undefined || tolerance <= 0) return [];
  const pools: LiquidityPool[] = [];
  for (const kind of ["high", "low"] as const) {
    const prices = swings.filter((s) => s.kind === kind).map((s) => s.price).sort((a, b) => a - b);
    let bucket: number[] = [];
    const flush = () => {
      if (bucket.length >= 2) {
        const price = bucket.reduce((a, b) => a + b, 0) / bucket.length;
        const side = kind === "high" ? "above" : "below";
        if ((side === "above" && price > lastClose) || (side === "below" && price < lastClose)) {
          pools.push({ side, price, touches: bucket.length });
        }
      }
      bucket = [];
    };
    for (const p of prices) {
      if (bucket.length === 0 || p - bucket[bucket.length - 1] <= tolerance) bucket.push(p);
      else { flush(); bucket = [p]; }
    }
    flush();
  }
  return pools.slice(0, 4);
}

export interface Zone {
  low: number;
  high: number;
}

/**
 * Supply/demand zones from displacement candles: a bar whose range ≥ 1.5 ATR
 * with a dominant body marks an impulse; the origin of that impulse is the
 * zone. A zone dies once price closes through its far edge. Nearest 2 per side.
 */
export function impulseZones(candles: Candle[], atrValue: number | null, lookback = 80): { demand: Zone[]; supply: Zone[] } {
  const lastClose = candles[candles.length - 1]?.close;
  if (!atrValue || atrValue <= 0 || lastClose === undefined) return { demand: [], supply: [] };
  const start = Math.max(1, candles.length - lookback);
  const demand: (Zone & { origin: number })[] = [];
  const supply: (Zone & { origin: number })[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range < atrValue * 1.5) continue;
    const body = Math.abs(c.close - c.open);
    if (range === 0 || body / range < 0.6) continue;
    if (c.close > c.open) demand.push({ low: c.low, high: Math.min(c.open, c.close), origin: i });
    else supply.push({ low: Math.max(c.open, c.close), high: c.high, origin: i });
  }
  // A zone survives only while no later close has traded through its far edge.
  const stillValid = (zone: Zone & { origin: number }, kind: "demand" | "supply") => {
    for (let i = zone.origin + 1; i < candles.length; i++) {
      if (kind === "demand" && candles[i].close < zone.low) return false;
      if (kind === "supply" && candles[i].close > zone.high) return false;
    }
    return true;
  };
  const validDemand = demand.filter((z) => stillValid(z, "demand") && z.high < lastClose);
  const validSupply = supply.filter((z) => stillValid(z, "supply") && z.low > lastClose);
  const nearest = (zones: (Zone & { origin: number })[]) =>
    zones
      .sort((a, b) => Math.abs((a.low + a.high) / 2 - lastClose) - Math.abs((b.low + b.high) / 2 - lastClose))
      .slice(0, 2)
      .map(({ low, high }) => ({ low, high }));
  return { demand: nearest(validDemand), supply: nearest(validSupply) };
}

export type Divergence = "NONE" | "BULLISH" | "BEARISH";

/**
 * Classic swing divergence: price makes a higher high while the oscillator
 * makes a lower high (bearish), or a lower low with a higher oscillator low
 * (bullish). `momentumAt` maps a candle index to the oscillator value there.
 */
export function detectDivergence(
  swings: SwingPoint[],
  momentumAt: (index: number) => number | null,
): Divergence {
  const highs = swings.filter((s) => s.kind === "high").slice(-2);
  const lows = swings.filter((s) => s.kind === "low").slice(-2);
  let bearish: number | null = null;
  let bullish: number | null = null;
  if (highs.length === 2) {
    const [a, b] = highs;
    const ma = momentumAt(a.index);
    const mb = momentumAt(b.index);
    if (ma !== null && mb !== null && b.price > a.price && mb < ma) bearish = b.index;
  }
  if (lows.length === 2) {
    const [a, b] = lows;
    const ma = momentumAt(a.index);
    const mb = momentumAt(b.index);
    if (ma !== null && mb !== null && b.price < a.price && mb > ma) bullish = b.index;
  }
  if (bearish !== null && bullish !== null) return bearish > bullish ? "BEARISH" : "BULLISH";
  if (bearish !== null) return "BEARISH";
  if (bullish !== null) return "BULLISH";
  return "NONE";
}

export interface MomentumRead {
  /** 0 = maximum bearish momentum, 100 = maximum bullish, 50 = flat. */
  score: number | null;
  rsi: number | null;
  rsiNote: string | null;
  macdNote: string | null;
  divergence: Divergence;
}

export function readMomentum(candles: Candle[], swings: SwingPoint[]): MomentumRead {
  const closes = candles.map((c) => c.close);
  const period = 14;
  const rsiArr = rsi(closes, period);
  const { macdLine, signalLine, histogram } = macd(closes);
  const r = last(rsiArr) ?? null;
  const rPrev = rsiArr[rsiArr.length - 2] ?? null;
  const hist = last(histogram) ?? null;
  const histPrev = histogram[histogram.length - 2] ?? null;
  const m = last(macdLine) ?? null;
  const s = last(signalLine) ?? null;

  if (r === null || hist === null || m === null || s === null) {
    return { score: null, rsi: r, rsiNote: null, macdNote: null, divergence: "NONE" };
  }

  let score = 50;
  score += Math.max(-25, Math.min(25, (r - 50) * 1.2));
  score += hist > 0 ? 10 : -10;
  if (histPrev !== null) score += Math.abs(hist) > Math.abs(histPrev) ? (hist > 0 ? 7 : -7) : hist > 0 ? -4 : 4;
  if (rPrev !== null) score += r > rPrev ? 8 : -8;
  score = Math.round(Math.max(0, Math.min(100, score)));

  const rsiDir = rPrev !== null ? (r > rPrev ? "rising" : "falling") : "flat";
  const rsiZone = r >= 70 ? "overbought" : r <= 30 ? "oversold" : r >= 55 ? "bullish" : r <= 45 ? "bearish" : "neutral";
  const rsiNote = `${rsiZone} (${r.toFixed(0)}, ${rsiDir})`;
  const macdSide = m > s ? "above signal" : "below signal";
  const histShape = histPrev === null ? "" : Math.abs(hist) > Math.abs(histPrev) ? ", histogram expanding" : ", histogram fading";
  const macdNote = `${hist > 0 ? "bullish" : "bearish"}, ${macdSide}${histShape}`;

  // rsi[i] corresponds to closes index i + period.
  const momentumAt = (index: number): number | null => rsiArr[index - period] ?? null;
  return { score, rsi: r, rsiNote, macdNote, divergence: detectDivergence(swings, momentumAt) };
}

export interface VolumeRead {
  /** Last bar volume vs 20-bar average (1.0 = average). */
  relative: number | null;
  trend: "RISING" | "FALLING" | "FLAT" | null;
  spike: boolean;
  /** Close-location-weighted volume balance over the window. */
  bias: "ACCUMULATION" | "DISTRIBUTION" | "NEUTRAL" | null;
  score: number | null;
}

export function readVolume(candles: Candle[], window = 20): VolumeRead {
  const vols = candles.map((c) => c.tick_volume ?? 0);
  if (vols.length < window + 1 || vols.every((v) => v <= 0)) {
    return { relative: null, trend: null, spike: false, bias: null, score: null };
  }
  const avg = sma(vols.slice(0, -1), window);
  const base = last(avg);
  if (!base || base <= 0) return { relative: null, trend: null, spike: false, bias: null, score: null };
  const relative = vols[vols.length - 1] / base;

  const short = last(sma(vols, 5));
  const long = base;
  const trend = short === undefined ? null : short > long * 1.15 ? "RISING" : short < long * 0.85 ? "FALLING" : "FLAT";

  // Accumulation/distribution: close-location value × volume, normalized.
  let signed = 0;
  let total = 0;
  for (const c of candles.slice(-window)) {
    const range = c.high - c.low;
    if (range <= 0) continue;
    const clv = (c.close - c.low - (c.high - c.close)) / range;
    const v = c.tick_volume ?? 0;
    signed += clv * v;
    total += v;
  }
  const balance = total > 0 ? signed / total : 0;
  const bias = balance > 0.15 ? "ACCUMULATION" : balance < -0.15 ? "DISTRIBUTION" : "NEUTRAL";
  return {
    relative: Number(relative.toFixed(2)),
    trend,
    spike: relative >= 2,
    bias,
    score: Math.round(Math.max(0, Math.min(100, relative * 50))),
  };
}

export interface VolatilityRead {
  atr: number | null;
  atrPct: number | null;
  /** Where the current ATR sits inside its own recent history (0–100). */
  percentile: number | null;
  regime: "LOW" | "NORMAL" | "HIGH" | "EXTREME" | null;
  /** Expected 1-bar move as % of price (current ATR). */
  expectedMovePct: number | null;
}

export function readVolatility(candles: Candle[], lookback = 100): VolatilityRead {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const atrArr = atr(highs, lows, closes, 14);
  const current = last(atrArr) ?? null;
  const lastClose = last(closes) ?? null;
  if (current === null || lastClose === null || lastClose <= 0) {
    return { atr: current, atrPct: null, percentile: null, regime: null, expectedMovePct: null };
  }
  const window = atrArr.slice(-lookback);
  let percentile: number | null = null;
  if (window.length >= 20) {
    const below = window.filter((v) => v <= current).length;
    percentile = Math.round((below / window.length) * 100);
  }
  const regime =
    percentile === null ? null : percentile < 25 ? "LOW" : percentile < 75 ? "NORMAL" : percentile < 92 ? "HIGH" : "EXTREME";
  const atrPct = (current / lastClose) * 100;
  return {
    atr: current,
    atrPct: Number(atrPct.toFixed(3)),
    percentile,
    regime,
    expectedMovePct: Number(atrPct.toFixed(3)),
  };
}

export interface TrendRead {
  direction: "BULLISH" | "BEARISH" | "RANGING";
  /** 0–100 composite of ADX, EMA separation, price location and structure. */
  strength: number | null;
  acceleration: "ACCELERATING" | "DECELERATING" | "STEADY" | null;
}

export function readTrend(candles: Candle[], structure: StructureRead): TrendRead {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const eFast = last(ema(closes, 20)) ?? null;
  const eSlow = last(ema(closes, 50)) ?? null;
  const lastClose = last(closes) ?? null;
  const atrArr = atr(highs, lows, closes, 14);
  const lastAtr = last(atrArr) ?? null;
  const adxArr = adx(highs, lows, closes, 14);
  const lastAdx = last(adxArr) ?? null;

  let direction: TrendRead["direction"] = "RANGING";
  if (eFast !== null && eSlow !== null && lastClose !== null) {
    if (eFast > eSlow && lastClose > eFast) direction = "BULLISH";
    else if (eFast < eSlow && lastClose < eFast) direction = "BEARISH";
  }

  let strength: number | null = null;
  if (lastAdx !== null && eFast !== null && eSlow !== null && lastAtr !== null && lastAtr > 0) {
    let s = Math.min(50, lastAdx); // ADX 0–50 → 0–50
    s += Math.min(25, (Math.abs(eFast - eSlow) / lastAtr) * 12.5); // EMA separation in ATRs
    if (direction !== "RANGING") s += 15; // price on the right side of its fast EMA
    if (
      (direction === "BULLISH" && structure.status === "BULLISH") ||
      (direction === "BEARISH" && structure.status === "BEARISH")
    ) {
      s += 10;
    }
    strength = Math.round(Math.max(0, Math.min(100, s)));
  }

  let acceleration: TrendRead["acceleration"] = null;
  const adxPrev = adxArr[adxArr.length - 4] ?? null;
  if (lastAdx !== null && adxPrev !== null) {
    acceleration = lastAdx > adxPrev + 1.5 ? "ACCELERATING" : lastAdx < adxPrev - 1.5 ? "DECELERATING" : "STEADY";
  }
  return { direction, strength, acceleration };
}

export interface TimeframeFeatures {
  timeframe: string;
  lastClose: number | null;
  trend: TrendRead;
  structure: StructureRead;
  momentum: MomentumRead;
  volume: VolumeRead;
  volatility: VolatilityRead;
  support: PriceLevel[];
  resistance: PriceLevel[];
  liquidity: LiquidityPool[];
  demandZones: Zone[];
  supplyZones: Zone[];
}

export function computeTimeframeFeatures(timeframe: string, candles: Candle[]): TimeframeFeatures {
  const swings = detectSwings(candles);
  const structure = readStructure(candles, swings);
  const volatility = readVolatility(candles);
  const tolerance = volatility.atr !== null ? volatility.atr * 0.5 : 0;
  const levels = keyLevels(candles, swings, tolerance);
  const pools = volatility.atr !== null ? liquidityPools(candles, swings, volatility.atr * 0.25) : [];
  const zones = impulseZones(candles, volatility.atr);
  return {
    timeframe,
    lastClose: candles[candles.length - 1]?.close ?? null,
    trend: readTrend(candles, structure),
    structure,
    momentum: readMomentum(candles, swings),
    volume: readVolume(candles),
    volatility,
    support: levels.support,
    resistance: levels.resistance,
    liquidity: pools,
    demandZones: zones.demand,
    supplyZones: zones.supply,
  };
}
