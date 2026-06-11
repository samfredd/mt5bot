import type { StrategyConfig } from "./types.js";

export const PRESET_STRATEGIES: { name: string; type: string; config: StrategyConfig }[] = [
  {
    name: "Trend Follower (H1)",
    type: "trend_following",
    config: {
      symbols: ["EURUSD", "GBPUSD"],
      timeframes: ["H1", "H4"],
      entry: {
        requireTrendAlignment: true,
        rsiOversold: 35,
        rsiOverbought: 65,
        useMacdCross: true,
        useCandlePatterns: false,
        minConfidence: 0.65,
      },
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 3.0, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 1.0 },
      maxTradesPerDay: 3,
      sessions: ["london", "newyork", "london_newyork_overlap"],
      newsBehavior: "pause",
    },
  },
  {
    name: "Price Action Scalper (M15)",
    type: "scalping",
    config: {
      symbols: ["EURUSD"],
      timeframes: ["M5", "M15"],
      entry: {
        requireTrendAlignment: false,
        rsiOversold: 25,
        rsiOverbought: 75,
        useMacdCross: false,
        useCandlePatterns: true,
        minConfidence: 0.7,
      },
      exit: { stopLossAtrMult: 1.0, takeProfitAtrMult: 1.5, trailingStop: false },
      lotSizing: { method: "fixed", fixedLots: 0.01, riskPct: 0.5 },
      maxTradesPerDay: 8,
      sessions: ["london_newyork_overlap"],
      newsBehavior: "pause",
    },
  },
  {
    name: "Swing Trader (H4/D1)",
    type: "swing",
    config: {
      symbols: ["XAUUSD", "EURUSD", "GBPJPY"],
      timeframes: ["H4", "D1"],
      entry: {
        requireTrendAlignment: true,
        rsiOversold: 30,
        rsiOverbought: 70,
        useMacdCross: true,
        useCandlePatterns: true,
        minConfidence: 0.6,
      },
      exit: { stopLossAtrMult: 2.0, takeProfitAtrMult: 4.0, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 1.0 },
      maxTradesPerDay: 2,
      sessions: ["asia", "london", "newyork", "london_newyork_overlap", "sydney"],
      newsBehavior: "reduce",
    },
  },
];
