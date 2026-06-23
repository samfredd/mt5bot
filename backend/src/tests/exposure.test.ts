import { describe, expect, it } from "vitest";
import { calculateExposure, evaluateExposureGate } from "../modules/risk/exposure.js";

describe("exposure calculations", () => {
  it("calculates signed base and quote currency exposure for FX", () => {
    const exposure = calculateExposure([
      { symbol: "EURUSD", direction: "buy", lots: 0.1, price: 1.1 },
      { symbol: "GBPUSD", direction: "sell", lots: 0.1, price: 1.25 },
    ]);

    expect(exposure.currencyUsd).toEqual({ EUR: 11000, USD: 1500, GBP: -12500 });
    expect(exposure.symbolUsd).toEqual({ EURUSD: 11000, GBPUSD: -12500 });
    expect(exposure.correlationGroups.USD_FX).toEqual({ grossUsd: 23500, netUsd: -1500 });
  });

  it("tracks metals and indices in separate correlation groups", () => {
    const exposure = calculateExposure([
      { symbol: "XAUUSD", direction: "buy", lots: 0.1, price: 2300 },
      { symbol: "US30", direction: "sell", lots: 1, price: 39000 },
    ]);

    expect(exposure.correlationGroups.METALS.grossUsd).toBe(23000);
    expect(exposure.correlationGroups.US_INDICES.netUsd).toBe(-39000);
  });

  it("blocks a proposal that exceeds currency or correlated exposure limits", () => {
    const result = evaluateExposureGate({
      positions: [{ symbol: "EURUSD", direction: "buy", lots: 0.1, price: 1.1 }],
      proposal: { symbol: "GBPUSD", direction: "buy", lots: 0.1, price: 1.25 },
      accountEquity: 10000,
      maxCurrencyExposurePct: 200,
      maxCorrelatedExposurePct: 200,
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("USD_FX gross exposure 235% exceeds 200%");
    expect(result.reasons).toContain("USD net exposure 235% exceeds 200%");
  });
});
