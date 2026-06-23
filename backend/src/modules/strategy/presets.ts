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
      symbols: [ALL_FX],
      timeframes: ["M15", "H1"],
      entry: {
        style: "confluence",
        requireTrendAlignment: true, // H1 must confirm the M15 signal
        rsiOversold: 30,
        rsiOverbought: 70,
        useMacdCross: true,
        useCandlePatterns: true,
        minConfidence: 0.6,
      },
      // Wide stops so spread/slippage is a small fraction of R: ~2.5R stop, 4R target.
      exit: { stopLossAtrMult: 2.5, takeProfitAtrMult: 4.0, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.5 },
      maxTradesPerDay: 6,
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
      symbols: [ALL_FX],
      timeframes: ["M5", "M15"],
      entry: {
        style: "mean_reversion",
        requireTrendAlignment: false,
        rsiOversold: 30,
        rsiOverbought: 70,
        useMacdCross: false,
        useCandlePatterns: true, // require a reversal candle to confirm the fade
        minConfidence: 0.6,
        regimeMaxAdx: 25, // stand aside in strong trends
      },
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.3, trailingStop: false },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.5 },
      maxTradesPerDay: 6,
      sessions: ["asia", "london", "newyork", "london_newyork_overlap", "sydney"],
      newsBehavior: "pause",
    },
  },
  {
    name: "Trend Follower (H1)",
    type: "trend_following",
    config: {
      symbols: ["EURUSD", "GBPUSD"],
      timeframes: ["H1", "H4"],
      entry: {
        style: "confluence",
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
        style: "confluence",
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
        style: "confluence",
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
  {
    name: "Mean Reversion (H1)",
    type: "mean_reversion",
    config: {
      symbols: ["EURUSD"],
      timeframes: ["H1", "H4"],
      entry: {
        style: "mean_reversion",
        requireTrendAlignment: false,
        rsiOversold: 30,
        rsiOverbought: 70,
        useMacdCross: false,
        useCandlePatterns: true,
        minConfidence: 0.55,
        regimeMaxAdx: 25,
      },
      // Fade extremes: stop beyond the band, target a partial reversion to the mean.
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.3, trailingStop: false },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 1.0 },
      maxTradesPerDay: 4,
      sessions: ["asia", "london", "newyork", "london_newyork_overlap", "sydney"],
      newsBehavior: "pause",
    },
  },
  {
    name: "Asian Range Breakout (H1)",
    type: "breakout",
    config: {
      symbols: ["EURUSD", "GBPUSD"],
      timeframes: ["H1"],
      entry: {
        style: "breakout",
        requireTrendAlignment: false,
        rsiOversold: 30,
        rsiOverbought: 70,
        useMacdCross: false,
        useCandlePatterns: false,
        minConfidence: 0.55,
      },
      // Stop a touch tighter than target; let the breakout run.
      exit: { stopLossAtrMult: 1.2, takeProfitAtrMult: 2.0, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 1.0 },
      maxTradesPerDay: 2,
      // London + the NY overlap — where the Asian range tends to break.
      sessions: ["london", "london_newyork_overlap"],
      newsBehavior: "pause",
    },
  },
];
