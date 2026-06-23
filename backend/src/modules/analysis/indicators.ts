/** Pure indicator math — no I/O, fully unit-testable. */

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  if (closes.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const out: number[] = [100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss))];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const offset = emaFast.length - emaSlow.length;
  const macdLine = emaSlow.map((v, i) => emaFast[i + offset] - v);
  const signalLine = ema(macdLine, signal);
  const histOffset = macdLine.length - signalLine.length;
  const histogram = signalLine.map((v, i) => macdLine[i + histOffset] - v);
  return { macdLine, signalLine, histogram };
}

export function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i - period + 1];
    const sd = Math.sqrt(slice.reduce((a, v) => a + (v - mean) ** 2, 0) / period);
    upper.push(mean + mult * sd);
    lower.push(mean - mult * sd);
  }
  return { upper, mid, lower };
}

export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number[] {
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  return sma(trs, period);
}

/**
 * Average Directional Index — trend STRENGTH (not direction), 0..100 (Wilder).
 * Low ADX (≲20–25) = range/chop, where mean-reversion works; high ADX = a
 * strong trend, where fading extremes gets run over. Used as a regime filter.
 */
export function adx(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const n = highs.length;
  if (n < period * 2 + 1) return [];

  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }

  // Wilder's running smoothing (seed = first `period` sum, then accumulate).
  const wilder = (vals: number[]) => {
    if (vals.length < period) return [];
    const out: number[] = [vals.slice(0, period).reduce((a, b) => a + b, 0)];
    for (let i = period; i < vals.length; i++) out.push(out[out.length - 1] - out[out.length - 1] / period + vals[i]);
    return out;
  };
  const trS = wilder(tr);
  const plusS = wilder(plusDM);
  const minusS = wilder(minusDM);

  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const plusDI = trS[i] === 0 ? 0 : (100 * plusS[i]) / trS[i];
    const minusDI = trS[i] === 0 ? 0 : (100 * minusS[i]) / trS[i];
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }
  if (dx.length < period) return [];

  const out: number[] = [dx.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < dx.length; i++) out.push((out[out.length - 1] * (period - 1) + dx[i]) / period);
  return out;
}

export function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}
