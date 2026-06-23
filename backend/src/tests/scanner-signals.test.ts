import { describe, expect, it } from "vitest";
import type { MarketAnalysis, TimeframeAnalysis } from "../modules/analysis/engine.js";
import { resolveScannerSymbols, scoreSymbol, selectDefaultScannerSymbols } from "../modules/trading/scanner.js";

function timeframe(overrides: Partial<TimeframeAnalysis>): TimeframeAnalysis {
  return {
    timeframe: "H1", trend: "ranging", rsi: 50, rsiPrevious: 50,
    macdHistogram: 0, macdPrevious: 0, macdCurrent: 0, signalPrevious: 0, signalCurrent: 0,
    emaFast: 1.1, emaSlow: 1.1, bollingerPosition: "inside", atr: 0.002, atrPct: 0.2,
    adx: 20, support: 1.09, resistance: 1.11, lastClose: 1.1, candlePattern: null,
    structure: "consolidation", ...overrides,
  };
}

function analysis(primary: TimeframeAnalysis, higher: TimeframeAnalysis): MarketAnalysis {
  return {
    symbol: "EURUSD", generatedAt: "2026-01-01T09:00:00Z", spreadPoints: 15,
    bid: 1.1, ask: 1.10015, session: "london", timeframes: [primary, higher],
    summary: "", referenceRange: null,
  };
}

describe("autonomous scanner signal direction", () => {
  it("does not score an already-positive MACD histogram as a cross", () => {
    const primary = timeframe({ macdPrevious: 0.2, signalPrevious: 0.1, macdCurrent: 0.3, signalCurrent: 0.2, macdHistogram: 0.1 });
    const higher = timeframe({ timeframe: "H4" });

    expect(scoreSymbol(analysis(primary, higher)).direction).toBeNull();
  });

  it("does not score RSI that remains oversold without recovering", () => {
    const primary = timeframe({ rsiPrevious: 28, rsi: 30 });
    const higher = timeframe({ timeframe: "H4" });

    expect(scoreSymbol(analysis(primary, higher)).direction).toBeNull();
  });

  it("rejects a candidate that conflicts with the higher timeframe", () => {
    const primary = timeframe({
      trend: "bullish", structure: "higher_highs",
      macdPrevious: -0.2, signalPrevious: -0.1, macdCurrent: 0.2, signalCurrent: 0.1,
    });
    const higher = timeframe({ timeframe: "H4", trend: "bearish" });

    expect(scoreSymbol(analysis(primary, higher)).direction).toBeNull();
  });
});

describe("autonomous scanner default coverage", () => {
  it("selects a broad broker-supported FX watchlist using the broker's actual symbol names", () => {
    const brokerSymbols = [
      "EURUSDm", "GBPUSDm", "USDJPYm", "AUDUSDm", "USDCADm", "USDCHFm", "NZDUSDm",
      "EURJPYm", "GBPJPYm", "AUDJPYm", "EURGBPm", "EURCHFm", "CADJPYm", "XAUUSDm",
    ];

    const selected = selectDefaultScannerSymbols(brokerSymbols);

    expect(selected.length).toBeGreaterThan(6);
    expect(selected).toContain("EURJPYm");
    expect(selected).toContain("GBPJPYm");
    expect(selected).toContain("AUDJPYm");
    expect(selected.length).toBeLessThanOrEqual(30);
  });

  it("resolves a saved plain-symbol watchlist to broker symbols at runtime", () => {
    const saved = ["EURUSD", "EURJPY", "XAUUSD", "UNKNOWN"];
    const brokerSymbols = ["EURUSDm", "EURJPYm", "XAUUSDm"];

    expect(resolveScannerSymbols(saved, brokerSymbols)).toEqual(["EURUSDm", "EURJPYm", "XAUUSDm", "UNKNOWN"]);
  });
});
