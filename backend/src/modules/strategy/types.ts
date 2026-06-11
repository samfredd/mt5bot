import { z } from "zod";

export const StrategyConfigSchema = z.object({
  symbols: z.array(z.string()).min(1),
  timeframes: z.array(z.string()).min(1).default(["M15", "H1"]),
  entry: z.object({
    requireTrendAlignment: z.boolean().default(true),
    rsiOversold: z.number().default(30),
    rsiOverbought: z.number().default(70),
    useMacdCross: z.boolean().default(true),
    useCandlePatterns: z.boolean().default(true),
    minConfidence: z.number().min(0).max(1).default(0.6),
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
  reasons: string[];
  strategyId: string;
  strategyName: string;
  config: StrategyConfig;
}
