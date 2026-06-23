import type { MonteCarloResult, PercentileRange } from "./types.js";

type MonteCarloTrade = { netPnl: number };

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value: number) => Number(value.toFixed(2));

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return round(sorted[index]);
}

function range(values: number[]): PercentileRange {
  return { p05: percentile(values, 0.05), p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

export function runMonteCarlo(
  trades: MonteCarloTrade[],
  initialBalance: number,
  options: { iterations?: number; seed?: number } = {},
): MonteCarloResult {
  const iterations = Math.max(1, Math.min(Math.floor(options.iterations ?? 2000), 20_000));
  const seed = Math.floor(options.seed ?? 1);
  if (!trades.length) {
    return {
      iterations,
      seed,
      tradeCount: 0,
      returnPct: { p05: 0, p50: 0, p95: 0 },
      finalBalance: { p05: round(initialBalance), p50: round(initialBalance), p95: round(initialBalance) },
      maxDrawdownPct: { p05: 0, p50: 0, p95: 0 },
    };
  }

  const random = mulberry32(seed);
  const returns: number[] = [];
  const balances: number[] = [];
  const drawdowns: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let balance = initialBalance;
    let peak = initialBalance;
    let maxDrawdownPct = 0;
    for (let index = 0; index < trades.length; index++) {
      const sampled = trades[Math.floor(random() * trades.length)];
      balance += sampled.netPnl;
      peak = Math.max(peak, balance);
      if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - balance) / peak) * 100);
    }
    balances.push(balance);
    returns.push(initialBalance > 0 ? ((balance - initialBalance) / initialBalance) * 100 : 0);
    drawdowns.push(maxDrawdownPct);
  }

  return {
    iterations,
    seed,
    tradeCount: trades.length,
    returnPct: range(returns),
    finalBalance: range(balances),
    maxDrawdownPct: range(drawdowns),
  };
}
