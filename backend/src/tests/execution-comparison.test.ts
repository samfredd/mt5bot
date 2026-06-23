import { describe, expect, it } from "vitest";
import { calculateExecutionVariance } from "../modules/trading/execution-comparison.js";

describe("execution comparison", () => {
  it("reports adverse buy entry and exit slippage as positive", () => {
    expect(calculateExecutionVariance({
      direction: "BUY",
      expectedEntry: 1.1,
      actualEntry: 1.1002,
      expectedExit: 1.102,
      actualExit: 1.1018,
      expectedPnl: 20,
      actualPnl: 16,
      requestedAt: new Date("2026-06-15T10:00:00.000Z"),
      filledAt: new Date("2026-06-15T10:00:00.250Z"),
    })).toEqual({
      entrySlippage: 0.0002,
      entryVariancePct: 0.02,
      exitSlippage: 0.0002,
      exitVariancePct: 0.02,
      latencyMs: 250,
      pnlVariance: -4,
      pnlVariancePct: -20,
    });
  });

  it("uses the inverse price direction for sells", () => {
    expect(calculateExecutionVariance({
      direction: "SELL",
      expectedEntry: 1.25,
      actualEntry: 1.2498,
      expectedExit: 1.248,
      actualExit: 1.2482,
      expectedPnl: 20,
      actualPnl: 18,
      requestedAt: new Date("2026-06-15T10:00:00.000Z"),
      filledAt: new Date("2026-06-15T10:00:01.000Z"),
    })).toMatchObject({ entrySlippage: 0.0002, exitSlippage: 0.0002, latencyMs: 1000, pnlVariance: -2 });
  });

  it("leaves unavailable exit and pnl fields null", () => {
    expect(calculateExecutionVariance({
      direction: "BUY",
      expectedEntry: 100,
      actualEntry: 100.5,
      requestedAt: new Date("2026-06-15T10:00:00.000Z"),
      filledAt: null,
    })).toMatchObject({
      entrySlippage: 0.5,
      latencyMs: null,
      exitSlippage: null,
      pnlVariance: null,
      pnlVariancePct: null,
    });
  });
});
