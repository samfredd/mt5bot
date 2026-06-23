import { z } from "zod";

/**
 * Zod is the single source of truth for the shape of scalping configuration and
 * scalping-specific risk settings. The PUT schemas are `.partial()` so the API
 * can patch a subset and merge it over the persisted record.
 *
 * Validation rules (rejecting unsafe values) live here so both the routes and
 * the worker share exactly one definition. If these ever move to real Prisma
 * models, this file becomes the validation layer in front of them.
 */

const Symbol = z
  .string()
  .trim()
  .min(3)
  .max(12)
  .transform((s) => s.toUpperCase());

export const ScalpingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  status: z.enum(["running", "paused", "stopped"]).default("stopped"),
  symbols: z.array(Symbol).min(1).max(30).default(["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"]),
  useAiFireControl: z.boolean().default(true),
  // PURE_LOGIC = no model call at all: trade on the technical signal + risk
  // gates only. STRICT/ADVISORY both use the AI as a fire-control gate.
  aiMode: z.enum(["STRICT", "ADVISORY", "PURE_LOGIC"]).default("STRICT"),
  minAiConfidence: z.number().min(0).max(1).default(0.72),
  aiDecisionTtlSeconds: z.number().int().min(10).max(600).default(60),
});

export const ScalpingRiskSchema = z.object({
  // Which risk style is active. "custom" = hand-tuned (the default, so existing
  // stored configs are never mislabelled). Selecting low/medium/aggressive
  // populates the mapped fields below from SCALPING_PRESETS; any later manual
  // edit flips this back to "custom".
  scalpingRiskPreset: z.enum(["low", "medium", "aggressive", "custom"]).default("custom"),

  maxOpenTradesTotal: z.number().int().min(1).max(10).default(5),
  // v1 deliberately supports exactly one active trade per symbol. We accept the
  // field but reject anything > 1 with a clear message rather than silently
  // clamping, so the operator understands the limit.
  maxTradesPerSymbol: z
    .number()
    .int()
    .min(1)
    .max(1, { message: "v1 supports exactly 1 active trade per symbol; multi-entry per pair is not available yet" })
    .default(1),

  // Per-trade exit basis. "money" derives the SL/TP price from the $ target/loss
  // (default, original behavior). "points" uses explicit price distances below.
  stopBasis: z.enum(["money", "points"]).default("money"),
  targetProfitMoney: z.number().positive().max(1_000_000).default(0.2),
  maxLossMoney: z.number().positive().max(1_000_000).default(0.05),
  // Used only when stopBasis === "points": take-profit / stop-loss as a price
  // distance in points. null falls back to the money basis if points is selected
  // without both values set.
  takeProfitPoints: z.number().positive().max(100_000).nullable().default(null),
  stopLossPoints: z.number().positive().max(100_000).nullable().default(null),
  maxLotSize: z.number().positive().max(1_000).default(0.01),

  // Lot sizing. "fixed" = the original behavior (broker-minimum lot, capped by
  // maxLotSize). "risk_percent" = size each trade so that hitting the stop loses
  // ~riskPerTradePercent of balance — a RISK multiplier, never a profit target.
  // Default stays "fixed" so live behavior is unchanged until a preset is chosen.
  lotMode: z.enum(["fixed", "risk_percent"]).default("fixed"),
  riskPerTradePercent: z.number().min(0.01).max(5).default(0.5),
  // When false, the UI/engine should not let a fixed lot override risk sizing.
  allowFixedLot: z.boolean().default(true),

  // Session profit goal: when the day's net realized scalp P/L reaches this, the
  // engine closes any open scalps and stops (status -> stopped). null = off.
  profitTargetMoney: z.number().positive().max(1_000_000).nullable().default(null),

  reentryAfterWinSeconds: z.number().int().min(1).max(86_400).default(1),
  reentryAfterLossSeconds: z.number().int().min(1).max(86_400).default(60),

  maxTradesPerDay: z.number().int().min(1).max(10_000).default(100),
  maxConsecutiveLosses: z.number().int().min(1).max(100).default(3),
  pauseAfterLossStreakMinutes: z.number().int().min(0).max(1_440).default(10),

  dailyLossLimitMoney: z.number().positive().max(1_000_000).nullable().optional(),
  // Realistically capped: a daily loss cap above 50% of balance is almost
  // certainly a typo and would defeat the protection.
  dailyLossLimitPercent: z.number().positive().max(50).nullable().optional().default(1.5),

  maxSharedCurrencyExposure: z.number().int().min(1).max(10).default(2),
  maxSpreadPointsBySymbol: z.record(z.string(), z.number().positive().max(10_000)).default({
    EURUSD: 15,
    GBPUSD: 20,
    USDJPY: 18,
    AUDUSD: 20,
    USDCAD: 22,
  }),

  allowedSessions: z.array(z.string()).default(["london", "newyork", "newyork_overlap"]),
  pauseDuringNews: z.boolean().default(true),
  pauseBeforeNewsMin: z.number().int().min(0).max(1_440).default(15),
  pauseAfterNewsMin: z.number().int().min(0).max(1_440).default(5),
  newsRiskLimit: z.enum(["LOW", "MEDIUM", "HIGH"]).default("HIGH"),
  flattenBeforeHighImpactNews: z.boolean().default(false),
});

/** Patch shapes for PUT — every field optional, same constraints when present. */
export const ScalpingConfigPatchSchema = ScalpingConfigSchema.partial();
export const ScalpingRiskPatchSchema = ScalpingRiskSchema.partial();

export type ScalpingConfig = z.infer<typeof ScalpingConfigSchema>;
export type ScalpingRiskConfig = z.infer<typeof ScalpingRiskSchema>;
export type ScalpingConfigPatch = z.infer<typeof ScalpingConfigPatchSchema>;
export type ScalpingRiskPatch = z.infer<typeof ScalpingRiskPatchSchema>;
