import { z } from "zod";

export const StrategyConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  validationStatus: z.enum(["unvalidated", "paper", "validated"]).default("unvalidated"),
  symbols: z.array(z.string()).min(1),
  timeframes: z.array(z.string()).min(1).default(["M15", "H1"]),
  entry: z.object({
    // "confluence" = trend/momentum scoring (the original engine).
    // "mean_reversion" = fade band extremes, only in ranging regimes.
    // "breakout" = trade the London break of the overnight Asian range.
    style: z.enum(["confluence", "mean_reversion", "breakout"]).default("confluence"),
    requireTrendAlignment: z.boolean().default(true),
    rsiOversold: z.number().default(30),
    rsiOverbought: z.number().default(70),
    useMacdCross: z.boolean().default(true),
    useCandlePatterns: z.boolean().default(true),
    usePrimaryTrend: z.boolean().optional(),
    useRsi: z.boolean().optional(),
    useStructure: z.boolean().optional(),
    minConfidence: z.number().min(0).max(1).default(0.6),
    // Deterministic quality controls. minConfidence remains the separate live
    // AI gate; these filters also apply when Pure Logic is selected.
    minRuleConfidence: z.number().min(0).max(1).optional(),
    trendMinAdx: z.number().min(0).optional(),
    maxExtensionAtr: z.number().positive().optional(),
    // Mean-reversion regime filter: skip when trend strength (ADX) exceeds this.
    // Omit/0 to disable. ~25 is the textbook range/trend divide.
    regimeMaxAdx: z.number().min(0).optional(),
    // Breakout quality: require a meaningful close outside a reasonably sized
    // Asian range instead of trading every one-tick poke through its edge.
    breakoutBufferAtr: z.number().min(0).optional(),
    breakoutMinRangeAtr: z.number().min(0).optional(),
    breakoutMaxRangeAtr: z.number().positive().optional(),
    breakoutRequireHigherAlignment: z.boolean().optional(),
  }),
  exit: z.object({
    stopLossAtrMult: z.number().positive().default(1.5),
    takeProfitAtrMult: z.number().positive().default(2.5),
    trailingStop: z.boolean().default(false),
  }),
  lotSizing: z.object({
    method: z.enum(["fixed", "risk_pct"]).default("risk_pct"),
    fixedLots: z.number().positive().default(0.01),
    riskPct: z.number().positive().default(1.0),
  }),
  maxTradesPerDay: z.number().int().positive().default(5),
  sessions: z.array(z.string()).default(["london", "newyork", "london_newyork_overlap"]),
  newsBehavior: z.enum(["pause", "reduce", "ignore"]).default("pause"),
});

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export interface StrategySignal {
  symbol: string;
  direction: "buy" | "sell" | null;
  /** Deterministic rule-confluence score; separate from the live AI confidence gate. */
  confidence: number;
  reasons: string[];
  strategyId: string;
  strategyName: string;
  config: StrategyConfig;
}
