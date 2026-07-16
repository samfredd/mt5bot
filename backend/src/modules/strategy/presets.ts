import type { StrategyConfig } from "./types.js";
import { ALL_FX } from "./symbols.js";

export const PRESET_STRATEGIES: { name: string; type: string; config: StrategyConfig }[] = [
  // ───────────────────────────────────────────────────────────────────────
  // "Any Pair" intraday templates (trade every broker FX pair via ALL_FX).
  //
  // HONEST STATUS (validated 2026-06-16 on real Exness history, spread-only
  // Standard costs, in-sample/out-of-sample split): NEITHER mechanical config
  // below has a proven edge. Confluence loses out-of-sample at every timeframe
  // (least-bad is M15/H1 with wide stops, still a slow bleed); mean-reversion
  // is near-breakeven on average but with huge per-symbol variance (one pair
  // PF 2.4, another PF 0.0 on the SAME rules — i.e. noise, not edge). They are
  // kept ONLY as starting points to iterate on with the backtester and to run
  // under paper-forward. The earlier M1/M5 scalp was REMOVED — at M1 the spread
  // is ~half the stop, so it lost ~95% in testing. Do NOT enable live without
  // your own walk-forward + paper-forward validation. The real differentiator
  // is the live AI gate (not simulated here) + the risk framework.
  // ───────────────────────────────────────────────────────────────────────
  {
    // Trend confluence on the slowest intraday pair tested (least cost drag,
    // highest win rate of the confluence variants). Still unproven — see above.
    name: "Intraday Trend (M15/H1) — Any Pair [UNPROVEN]",
    type: "trend_following",
    config: {
      version: 2,
      validationStatus: "unvalidated",
      symbols: [ALL_FX],
      timeframes: ["M15", "H1"],
      entry: {
        style: "confluence",
        requireTrendAlignment: true, // H1 must confirm the M15 signal
        rsiOversold: 30,
        rsiOverbought: 70,
        useMacdCross: true,
        useCandlePatterns: true,
        minConfidence: 0.72,
        minRuleConfidence: 0.6,
        trendMinAdx: 20,
        maxExtensionAtr: 1,
      },
      // Wide stops so spread/slippage is a small fraction of R: ~2.5R stop, 4R target.
      exit: { stopLossAtrMult: 2.0, takeProfitAtrMult: 3.5, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 4,
      sessions: ["asia", "london", "newyork", "london_newyork_overlap", "sydney"],
      newsBehavior: "pause",
    },
  },
  {
    // Fade band extremes in ranging regimes (ADX filter). The only style that
    // wasn't structurally negative, but per-symbol variance is large — treat as
    // experimental and paper-forward before trusting it.
    name: "Mean-Reversion Fade (M5/M15) — Any Pair [EXPERIMENTAL]",
    type: "mean_reversion",
    config: {
      version: 2,
      validationStatus: "unvalidated",
      symbols: [ALL_FX],
      timeframes: ["M5", "M15"],
      entry: {
        style: "mean_reversion",
        requireTrendAlignment: false,
        rsiOversold: 25,
        rsiOverbought: 75,
        useMacdCross: false,
        useCandlePatterns: true, // require a reversal candle to confirm the fade
        minConfidence: 0.72,
        regimeMaxAdx: 20, // stand aside before a strong trend develops
      },
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.5, trailingStop: false },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 3,
      sessions: ["asia", "london", "newyork", "london_newyork_overlap", "sydney"],
      newsBehavior: "pause",
    },
  },
  {
    name: "Trend Follower (H1)",
    type: "trend_following",
    config: {
      version: 2,
      validationStatus: "unvalidated",
      symbols: ["EURUSD", "GBPUSD"],
      timeframes: ["H1", "H4"],
      entry: {
        style: "confluence",
        requireTrendAlignment: true,
        rsiOversold: 35,
        rsiOverbought: 65,
        useMacdCross: true,
        useCandlePatterns: false,
        minConfidence: 0.7,
        minRuleConfidence: 0.5,
        trendMinAdx: 20,
        maxExtensionAtr: 1.25,
      },
      exit: { stopLossAtrMult: 2.0, takeProfitAtrMult: 3.5, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.5 },
      maxTradesPerDay: 2,
      sessions: ["london", "newyork", "london_newyork_overlap"],
      newsBehavior: "pause",
    },
  },
  {
    name: "Selective Price Action (M15/H1) [UNVALIDATED]",
    type: "intraday",
    config: {
      version: 2,
      validationStatus: "unvalidated",
      symbols: ["EURUSD"],
      timeframes: ["M15", "H1"],
      entry: {
        style: "confluence",
        requireTrendAlignment: true,
        rsiOversold: 30,
        rsiOverbought: 70,
        useMacdCross: false,
        useCandlePatterns: true,
        useRsi: false,
        minConfidence: 0.72,
        minRuleConfidence: 0.66,
        trendMinAdx: 18,
        maxExtensionAtr: 1,
      },
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.5, trailingStop: false },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 3,
      sessions: ["london_newyork_overlap"],
      newsBehavior: "pause",
    },
  },
  {
    name: "Swing Trader (H4/D1)",
    type: "swing",
    config: {
      version: 2,
      validationStatus: "unvalidated",
      symbols: ["XAUUSD", "EURUSD", "GBPJPY"],
      timeframes: ["H4", "D1"],
      entry: {
        style: "confluence",
        requireTrendAlignment: true,
        rsiOversold: 30,
        rsiOverbought: 70,
        useMacdCross: true,
        useCandlePatterns: true,
        minConfidence: 0.72,
        minRuleConfidence: 0.6,
        trendMinAdx: 18,
        maxExtensionAtr: 1.25,
      },
      exit: { stopLossAtrMult: 2.5, takeProfitAtrMult: 4.5, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.35 },
      maxTradesPerDay: 1,
      sessions: ["asia", "london", "newyork", "london_newyork_overlap", "sydney"],
      newsBehavior: "reduce",
    },
  },
  {
    name: "Mean Reversion (H1)",
    type: "mean_reversion",
    config: {
      version: 2,
      validationStatus: "unvalidated",
      symbols: ["EURUSD"],
      timeframes: ["H1", "H4"],
      entry: {
        style: "mean_reversion",
        requireTrendAlignment: false,
        rsiOversold: 25,
        rsiOverbought: 75,
        useMacdCross: false,
        useCandlePatterns: true,
        minConfidence: 0.72,
        regimeMaxAdx: 20,
      },
      // Fade extremes: stop beyond the band, target a partial reversion to the mean.
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.5, trailingStop: false },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 2,
      sessions: ["asia", "london", "newyork", "london_newyork_overlap", "sydney"],
      newsBehavior: "pause",
    },
  },
  {
    name: "Asian Range Breakout (H1)",
    type: "breakout",
    config: {
      version: 2,
      validationStatus: "unvalidated",
      symbols: ["EURUSD", "GBPUSD"],
      timeframes: ["H1", "H4"],
      entry: {
        style: "breakout",
        requireTrendAlignment: true,
        rsiOversold: 30,
        rsiOverbought: 70,
        useMacdCross: false,
        useCandlePatterns: false,
        minConfidence: 0.72,
        breakoutBufferAtr: 0.15,
        breakoutMinRangeAtr: 0.75,
        breakoutMaxRangeAtr: 2.5,
        breakoutRequireHigherAlignment: true,
      },
      // Stop a touch tighter than target; let the breakout run.
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.75, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 1,
      // London + the NY overlap — where the Asian range tends to break.
      sessions: ["london"],
      newsBehavior: "pause",
    },
  },
];
