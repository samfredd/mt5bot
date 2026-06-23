import { describe, expect, it } from "vitest";
import type { Candle } from "../modules/mt5/client.js";
import {
  aggregatePortfolioValidation,
  evaluateOosGate,
  splitTrainOos,
} from "../modules/backtest/validation.js";

const candles = Array.from({ length: 1000 }, (_, index): Candle => ({
  time: new Date(Date.UTC(2024, 0, 1) + index * 3600_000).toISOString(),
  open: 1,
  high: 1.01,
  low: 0.99,
  close: 1,
  tick_volume: 100,
}));

describe("splitTrainOos", () => {
  it("uses the final chronological 20% exclusively as OOS", () => {
    const split = splitTrainOos(candles, 0.2);
    expect(split.train).toHaveLength(800);
    expect(split.oos).toHaveLength(200);
    expect(split.train.at(-1)?.time).toBe(candles[799].time);
    expect(split.oos[0].time).toBe(candles[800].time);
    expect(split.trainEnd).toBe(candles[799].time);
    expect(split.oosStart).toBe(candles[800].time);
  });
});

describe("evaluateOosGate", () => {
  it("passes sufficiently profitable and controlled OOS evidence", () => {
    expect(evaluateOosGate({
      trades: 25,
      returnPct: 3.2,
      profitFactor: 1.35,
      maxDrawdownPct: 4.5,
      monteCarloReturnP05: 0.4,
    })).toEqual({ passed: true, reasons: [] });
  });

  it("returns every rejection reason instead of a generic verdict", () => {
    const result = evaluateOosGate({
      trades: 4,
      returnPct: -1,
      profitFactor: 0.8,
      maxDrawdownPct: 14,
      monteCarloReturnP05: -2,
    });
    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual([
      "OOS trades 4 below minimum 20",
      "OOS return -1% is not positive",
      "OOS profit factor 0.8 below 1.1",
      "OOS drawdown 14% exceeds 10%",
      "Monte Carlo 5th-percentile return -2% is not positive",
    ]);
  });
});

describe("aggregatePortfolioValidation", () => {
  it("requires breadth across instruments and aggregates metrics", () => {
    const result = aggregatePortfolioValidation([
      { symbol: "EURUSD", trades: 30, returnPct: 2, maxDrawdownPct: 4, passed: true },
      { symbol: "GBPUSD", trades: 25, returnPct: 1, maxDrawdownPct: 5, passed: true },
      { symbol: "XAUUSD", trades: 20, returnPct: -0.5, maxDrawdownPct: 8, passed: false },
    ]);
    expect(result).toMatchObject({
      instruments: 3,
      profitableInstruments: 2,
      profitableFraction: 0.67,
      totalTrades: 75,
      meanReturnPct: 0.83,
      worstDrawdownPct: 8,
      passed: true,
    });
  });

  it("fails a one-instrument result even when it is profitable", () => {
    const result = aggregatePortfolioValidation([
      { symbol: "EURUSD", trades: 40, returnPct: 4, maxDrawdownPct: 3, passed: true },
    ]);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("Portfolio validation requires at least 3 instruments");
  });
});
