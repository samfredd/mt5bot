import type { Candle } from "../mt5/client.js";

export const TIMEFRAME_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
};

export function timeframeMinutes(timeframe: string): number {
  return TIMEFRAME_MINUTES[timeframe] ?? 60;
}

/**
 * Canonical candle preparation used by live analysis and backtests.
 * Duplicate timestamps keep the last received value because MT5 may refresh
 * the current bar in place. When `asOfMs` is finite, unfinished bars are
 * excluded using the timeframe close boundary.
 */
export function normalizeCandles(
  candles: Candle[],
  timeframe: string,
  asOfMs = Number.POSITIVE_INFINITY,
): Candle[] {
  const durationMs = timeframeMinutes(timeframe) * 60_000;
  const byTime = new Map<number, Candle>();

  for (const candle of candles) {
    const timeMs = Date.parse(candle.time);
    if (!Number.isFinite(timeMs)) continue;
    if (Number.isFinite(asOfMs) && timeMs + durationMs > asOfMs) continue;
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    if (candle.high < candle.low) continue;
    byTime.set(timeMs, { ...candle, time: new Date(timeMs).toISOString() });
  }

  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, candle]) => candle);
}

/**
 * Count of distinct, valid candles — same validity filter as normalizeCandles
 * (finite OHLC, high≥low, deduped by timestamp) but without the sort/allocation.
 * Equals `normalizeCandles(candles, tf).length`; used for data-quality stats.
 */
export function distinctValidCount(candles: Candle[]): number {
  const seen = new Set<number>();
  for (const candle of candles) {
    const timeMs = Date.parse(candle.time);
    if (!Number.isFinite(timeMs)) continue;
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    if (candle.high < candle.low) continue;
    seen.add(timeMs);
  }
  return seen.size;
}

export function candlesVisibleAt(
  candles: Candle[],
  timeframe: string,
  asOfMs: number,
  limit?: number,
): Candle[] {
  const visible = normalizeCandles(candles, timeframe, asOfMs);
  return limit && visible.length > limit ? visible.slice(-limit) : visible;
}

export function isNewCompletedBar(currentTime: string, lastProcessedTime: string | null): boolean {
  const current = Date.parse(currentTime);
  const previous = lastProcessedTime ? Date.parse(lastProcessedTime) : Number.NEGATIVE_INFINITY;
  return Number.isFinite(current) && current > previous;
}

/** Aggregate lower-timeframe candles using an explicit broker boundary offset. */
export function aggregateCandles(
  candles: Candle[],
  fromMin: number,
  toMin: number,
  alignmentOffsetMinutes = 0,
): Candle[] {
  if (toMin <= fromMin || toMin % fromMin !== 0) return [...candles];

  const ordered = normalizeCandles(candles, `${fromMin}m`);
  const bucketMs = toMin * 60_000;
  const offsetMs = alignmentOffsetMinutes * 60_000;
  const out: Candle[] = [];
  let bucket: Candle | null = null;
  let bucketKey = Number.NaN;

  for (const candle of ordered) {
    const timeMs = Date.parse(candle.time);
    const key = Math.floor((timeMs - offsetMs) / bucketMs);
    if (key !== bucketKey) {
      if (bucket) out.push(bucket);
      bucket = {
        ...candle,
        time: new Date(key * bucketMs + offsetMs).toISOString(),
      };
      bucketKey = key;
      continue;
    }

    if (bucket) {
      bucket.high = Math.max(bucket.high, candle.high);
      bucket.low = Math.min(bucket.low, candle.low);
      bucket.close = candle.close;
      bucket.tick_volume += candle.tick_volume;
    }
  }

  if (bucket) out.push(bucket);
  return out;
}
