import { describe, expect, it } from "vitest";
import { resemblesRecentRejectedIdea, sensitivityVariants, strategyLabValidationVerdict } from "../modules/strategy/lab.js";
import { StrategyConfigSchema } from "../modules/strategy/types.js";

const base = StrategyConfigSchema.parse({
  symbols: ["XAUUSD"],
  timeframes: ["H1", "H4"],
  entry: { style: "mean_reversion", rsiOversold: 40, rsiOverbought: 60, regimeMaxAdx: 25, useCandlePatterns: false, useMacdCross: false },
  exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.3 },
  lotSizing: { method: "risk_pct", riskPct: 1 },
});

describe("strategy-lab sensitivity variants", () => {
  it("produces only schema-valid neighbour configs", () => {
    const variants = sensitivityVariants(base);
    expect(variants.length).toBeGreaterThanOrEqual(2);
    for (const v of variants) expect(StrategyConfigSchema.safeParse(v).success).toBe(true);
  });

  it("perturbs the exit multiples around the base", () => {
    const variants = sensitivityVariants(base);
    const slMults = variants.map((v) => v.exit.stopLossAtrMult);
    expect(slMults.some((m) => m < 1.5)).toBe(true); // a lower-stop neighbour
    expect(slMults.some((m) => m > 1.5)).toBe(true); // a higher-stop neighbour
  });

  it("perturbs the ADX regime knob for mean-reversion", () => {
    const adxValues = sensitivityVariants(base).map((v) => v.entry.regimeMaxAdx);
    expect(adxValues).toContain(20);
    expect(adxValues).toContain(30);
  });
});

describe("strategy-lab validation verdict", () => {
  it("passes only when every research gate passes", () => {
    expect(strategyLabValidationVerdict({
      walkForwardPassed: true,
      sensitivityPassed: true,
      oos: { passed: true, reasons: [] },
      portfolio: { passed: true, reasons: [] },
    })).toEqual({ passed: true, reasons: [] });
  });

  it("returns explicit reasons from every failed gate", () => {
    expect(strategyLabValidationVerdict({
      walkForwardPassed: false,
      sensitivityPassed: false,
      oos: { passed: false, reasons: ["OOS trades below minimum"] },
      portfolio: { passed: false, reasons: ["Portfolio mean return is not positive"] },
    })).toEqual({
      passed: false,
      reasons: [
        "Training walk-forward gate failed",
        "Parameter sensitivity gate failed",
        "OOS trades below minimum",
        "Portfolio mean return is not positive",
      ],
    });
  });
});

describe("strategy-lab rejected idea memory", () => {
  it("detects repeated same-symbol mean-reversion hypotheses with renamed wording", () => {
    expect(resemblesRecentRejectedIdea({
      name: "USDCAD Mean Reversion on Ranging Conditions",
      rationale: "range",
      symbol: "USDCAD",
      style: "mean_reversion",
      timeframe: "H1",
    }, [
      { name: "USDCAD Mean Reversion on Ranging Market", symbol: "USDCAD", reasons: ["OOS return negative"] },
    ])).toBe(true);
  });

  it("does not reject a different symbol or strategy style", () => {
    expect(resemblesRecentRejectedIdea({
      name: "USDCAD London Breakout",
      rationale: "range expansion",
      symbol: "USDCAD",
      style: "breakout",
      timeframe: "M15",
    }, [
      { name: "USDCAD Mean Reversion on Ranging Market", symbol: "USDCAD", reasons: ["OOS return negative"] },
      { name: "EURUSD London Breakout", symbol: "EURUSD", reasons: ["OOS trades below minimum"] },
    ])).toBe(false);
  });
});
