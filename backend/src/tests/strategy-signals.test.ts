import { describe, expect, it } from "vitest";
import type { Strategy } from "@prisma/client";
import type { MarketAnalysis, TimeframeAnalysis } from "../modules/analysis/engine.js";
import { evaluateStrategy } from "../modules/strategy/service.js";

const strategy = {
  id: "signal-audit",
  userId: "user",
  name: "Signal Audit",
  type: "trend_following",
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  config: {
    symbols: ["EURUSD"],
    timeframes: ["H1", "H4"],
    entry: {
      style: "confluence",
      requireTrendAlignment: true,
      rsiOversold: 40,
      rsiOverbought: 60,
      useMacdCross: true,
      useCandlePatterns: true,
      minConfidence: 0.78,
    },
    exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.4, trailingStop: true },
    lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.5 },
    maxTradesPerDay: 3,
    sessions: ["london"],
    newsBehavior: "pause",
  },
} satisfies Strategy;

function timeframe(overrides: Partial<TimeframeAnalysis>): TimeframeAnalysis {
  return {
    timeframe: "H1",
    trend: "ranging",
    rsi: 50,
    rsiPrevious: 50,
    macdHistogram: 0,
    macdPrevious: 0,
    macdCurrent: 0,
    signalPrevious: 0,
    signalCurrent: 0,
    emaFast: 1.1,
    emaSlow: 1.1,
    bollingerPosition: "inside",
    atr: 0.002,
    atrPct: 0.2,
    adx: 20,
    support: 1.09,
    resistance: 1.11,
    lastClose: 1.1,
    candlePattern: null,
    structure: "consolidation",
    ...overrides,
  };
}

function analysis(primary: TimeframeAnalysis, higher: TimeframeAnalysis): MarketAnalysis {
  return {
    symbol: "EURUSD",
    generatedAt: "2026-01-01T09:00:00Z",
    spreadPoints: 15,
    bid: 1.1,
    ask: 1.10015,
    session: "london",
    timeframes: [primary, higher],
    summary: "",
    referenceRange: null,
  };
}

describe("confluence signal direction", () => {
  it("supports a trend-alignment-only diagnostic configuration", () => {
    const trendOnly = {
      ...strategy,
      config: {
        ...strategy.config,
        entry: {
          ...strategy.config.entry,
          usePrimaryTrend: true,
          useRsi: false,
          useMacdCross: false,
          useCandlePatterns: false,
          useStructure: false,
        },
      },
    } as Strategy;
    const primary = timeframe({ trend: "bullish" });
    const higher = timeframe({ timeframe: "H4", trend: "bullish" });

    expect(evaluateStrategy(trendOnly, analysis(primary, higher)).direction).toBe("buy");
  });

  it("buys on a bullish MACD cross with bullish trend alignment", () => {
    const primary = timeframe({
      trend: "bullish",
      macdPrevious: -0.0002,
      signalPrevious: -0.0001,
      macdCurrent: 0.0002,
      signalCurrent: 0.0001,
      macdHistogram: 0.0001,
    });
    const higher = timeframe({ timeframe: "H4", trend: "bullish" });

    expect(evaluateStrategy(strategy, analysis(primary, higher)).direction).toBe("buy");
  });

  it("does not treat an already-positive MACD histogram as a fresh cross", () => {
    const primary = timeframe({
      trend: "bullish",
      macdPrevious: 0.0002,
      signalPrevious: 0.0001,
      macdCurrent: 0.0003,
      signalCurrent: 0.0002,
      macdHistogram: 0.0001,
    });
    const higher = timeframe({ timeframe: "H4", trend: "bullish" });

    expect(evaluateStrategy(strategy, analysis(primary, higher)).direction).toBeNull();
  });

  it("buys when RSI recovers upward through the oversold threshold", () => {
    const primary = timeframe({ trend: "bullish", rsiPrevious: 39, rsi: 41 });
    const higher = timeframe({ timeframe: "H4", trend: "bullish" });

    expect(evaluateStrategy(strategy, analysis(primary, higher)).direction).toBe("buy");
  });

  it("does not buy merely because RSI remains below the oversold threshold", () => {
    const primary = timeframe({ trend: "bullish", rsiPrevious: 38, rsi: 39 });
    const higher = timeframe({ timeframe: "H4", trend: "bullish" });

    expect(evaluateStrategy(strategy, analysis(primary, higher)).direction).toBeNull();
  });

  it("sells on a bearish MACD cross with bearish trend alignment", () => {
    const primary = timeframe({
      trend: "bearish",
      macdPrevious: 0.0002,
      signalPrevious: 0.0001,
      macdCurrent: -0.0002,
      signalCurrent: -0.0001,
      macdHistogram: -0.0001,
    });
    const higher = timeframe({ timeframe: "H4", trend: "bearish" });

    expect(evaluateStrategy(strategy, analysis(primary, higher)).direction).toBe("sell");
  });

  it("sells when RSI falls back through the overbought threshold", () => {
    const primary = timeframe({ trend: "bearish", rsiPrevious: 61, rsi: 59 });
    const higher = timeframe({ timeframe: "H4", trend: "bearish" });

    expect(evaluateStrategy(strategy, analysis(primary, higher)).direction).toBe("sell");
  });

  it("does not let a bullish candle pattern authorize a sell", () => {
    const primary = timeframe({ trend: "bearish", candlePattern: "bullish_engulfing" });
    const higher = timeframe({ timeframe: "H4", trend: "bearish" });

    expect(evaluateStrategy(strategy, analysis(primary, higher)).direction).toBeNull();
  });

  it("rejects a direction that conflicts with the higher timeframe", () => {
    const primary = timeframe({
      trend: "bullish",
      macdPrevious: -0.0002,
      signalPrevious: -0.0001,
      macdCurrent: 0.0002,
      signalCurrent: 0.0001,
    });
    const higher = timeframe({ timeframe: "H4", trend: "bearish" });

    expect(evaluateStrategy(strategy, analysis(primary, higher)).direction).toBeNull();
  });
});
