import { describe, expect, it } from "vitest";
import { runMonteCarlo } from "../modules/backtest/monte-carlo.js";

describe("runMonteCarlo", () => {
  const trades = [100, -50, 75, -25, 40].map((netPnl) => ({ netPnl }));

  it("is deterministic for a fixed seed", () => {
    const first = runMonteCarlo(trades, 10_000, { iterations: 500, seed: 42 });
    const second = runMonteCarlo(trades, 10_000, { iterations: 500, seed: 42 });
    expect(first).toEqual(second);
  });

  it("returns ordered confidence percentiles", () => {
    const result = runMonteCarlo(trades, 10_000, { iterations: 500, seed: 7 });
    expect(result.returnPct.p05).toBeLessThanOrEqual(result.returnPct.p50);
    expect(result.returnPct.p50).toBeLessThanOrEqual(result.returnPct.p95);
    expect(result.finalBalance.p05).toBeLessThanOrEqual(result.finalBalance.p95);
    expect(result.maxDrawdownPct.p05).toBeLessThanOrEqual(result.maxDrawdownPct.p95);
    expect(result.iterations).toBe(500);
    expect(result.tradeCount).toBe(5);
  });

  it("returns zero-width evidence when there are no trades", () => {
    expect(runMonteCarlo([], 10_000, { iterations: 100, seed: 1 })).toMatchObject({
      tradeCount: 0,
      returnPct: { p05: 0, p50: 0, p95: 0 },
      finalBalance: { p05: 10000, p50: 10000, p95: 10000 },
      maxDrawdownPct: { p05: 0, p50: 0, p95: 0 },
    });
  });
});
