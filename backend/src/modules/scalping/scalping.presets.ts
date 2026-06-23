import type { ScalpingConfig, ScalpingRiskConfig } from "./scalping.schema.js";

/**
 * Scalping risk presets — three coherent risk styles plus "custom".
 *
 * A preset is just DATA that populates the existing scalping config + risk
 * fields (we reuse them; the spec's alternate names like `maxSimultaneousTrades`
 * are only UI labels). Selecting a preset merges its `config`/`risk` partials
 * over the persisted settings; editing any value afterwards flips the active
 * preset back to "custom" (see {@link detectPreset}).
 *
 * Hard rule baked in: Aggressive is faster, not reckless. Every preset keeps a
 * daily-loss cap, a consecutive-loss stop, spread caps, a news filter, and a
 * total-exposure ceiling (see {@link EXPOSURE_CAP_PCT}). Lot size in these
 * presets is risk-based — a RISK multiplier sized off the stop, never a profit
 * target.
 */

export type ScalpingPresetKey = "low" | "medium" | "aggressive";

export interface ScalpingPreset {
  config: Partial<ScalpingConfig>;
  risk: Partial<ScalpingRiskConfig>;
}

/**
 * Total simultaneous open risk (maxOpenTradesTotal × riskPerTradePercent) may
 * never exceed this, per style. "custom" is held to the Aggressive ceiling so
 * even a hand-tuned config in risk_percent mode cannot run away. Only enforced
 * in risk_percent lot mode — fixed-lot exposure is bounded by maxLotSize.
 */
export const EXPOSURE_CAP_PCT: Record<ScalpingPresetKey | "custom", number> = {
  low: 1,
  medium: 2,
  aggressive: 5,
  custom: 5,
};

export const SCALPING_PRESETS: Record<ScalpingPresetKey, ScalpingPreset> = {
  // Capital protection, slow growth. Tight spreads, overlap session only,
  // strict news pause, smallest risk per trade. Exposure 2 × 0.25 = 0.5% ≤ 1%.
  low: {
    config: { minAiConfidence: 0.82 },
    risk: {
      scalpingRiskPreset: "low",
      lotMode: "risk_percent",
      riskPerTradePercent: 0.25,
      allowFixedLot: false,
      maxOpenTradesTotal: 2,
      dailyLossLimitPercent: 2,
      maxTradesPerDay: 15,
      reentryAfterLossSeconds: 600, // cooldown 10 min
      maxConsecutiveLosses: 3,
      maxSharedCurrencyExposure: 1,
      stopBasis: "points",
      stopLossPoints: 50,
      takeProfitPoints: 100,
      allowedSessions: ["newyork_overlap"],
      maxSpreadPointsBySymbol: { EURUSD: 10, GBPUSD: 12, USDJPY: 10, AUDUSD: 12, USDCAD: 12 },
      pauseDuringNews: true,
      pauseBeforeNewsMin: 30,
      pauseAfterNewsMin: 15,
      newsRiskLimit: "LOW",
      flattenBeforeHighImpactNews: true,
    },
  },
  // Balanced growth and controlled drawdown. Exposure 3 × 0.5 = 1.5% ≤ 2%.
  medium: {
    config: { minAiConfidence: 0.76 },
    risk: {
      scalpingRiskPreset: "medium",
      lotMode: "risk_percent",
      riskPerTradePercent: 0.5,
      allowFixedLot: true,
      maxOpenTradesTotal: 3,
      dailyLossLimitPercent: 4,
      maxTradesPerDay: 30,
      reentryAfterLossSeconds: 300, // cooldown 5 min
      maxConsecutiveLosses: 4,
      maxSharedCurrencyExposure: 2,
      stopBasis: "points",
      stopLossPoints: 50,
      takeProfitPoints: 100,
      allowedSessions: ["london", "newyork", "newyork_overlap"],
      maxSpreadPointsBySymbol: { EURUSD: 15, GBPUSD: 20, USDJPY: 18, AUDUSD: 20, USDCAD: 22 },
      pauseDuringNews: true,
      pauseBeforeNewsMin: 15,
      pauseAfterNewsMin: 5,
      newsRiskLimit: "HIGH",
      flattenBeforeHighImpactNews: false,
    },
  },
  // Faster growth, higher drawdown — still hard-capped. Exposure 5 × 1.0 = 5% ≤ 5%.
  aggressive: {
    config: { minAiConfidence: 0.68 },
    risk: {
      scalpingRiskPreset: "aggressive",
      lotMode: "risk_percent",
      riskPerTradePercent: 1.0,
      allowFixedLot: true,
      maxOpenTradesTotal: 5,
      dailyLossLimitPercent: 7,
      maxTradesPerDay: 50,
      reentryAfterLossSeconds: 120, // cooldown 2 min
      maxConsecutiveLosses: 5,
      maxSharedCurrencyExposure: 3,
      stopBasis: "points",
      stopLossPoints: 60,
      takeProfitPoints: 90,
      allowedSessions: ["london", "newyork", "newyork_overlap"],
      maxSpreadPointsBySymbol: { EURUSD: 25, GBPUSD: 30, USDJPY: 28, AUDUSD: 30, USDCAD: 32 },
      pauseDuringNews: true,
      pauseBeforeNewsMin: 5,
      pauseAfterNewsMin: 2,
      newsRiskLimit: "HIGH",
      flattenBeforeHighImpactNews: false,
    },
  },
};

/** Fields a preset controls, used by detectPreset for an exact-match check. */
const PRESET_RISK_FIELDS: (keyof ScalpingRiskConfig)[] = [
  "lotMode", "riskPerTradePercent", "allowFixedLot", "maxOpenTradesTotal",
  "dailyLossLimitPercent", "maxTradesPerDay", "reentryAfterLossSeconds",
  "maxConsecutiveLosses", "maxSharedCurrencyExposure", "stopBasis",
  "stopLossPoints", "takeProfitPoints", "allowedSessions", "maxSpreadPointsBySymbol",
  "pauseDuringNews", "pauseBeforeNewsMin", "pauseAfterNewsMin", "newsRiskLimit",
  "flattenBeforeHighImpactNews",
];

/** Order-independent deep equality (object key order must not matter, since a
 * DB round-trip can reorder keys in maxSpreadPointsBySymbol). */
const norm = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, norm(val)]),
    );
  }
  return v;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/**
 * Which preset the CURRENT values correspond to, or "custom" when they match
 * none exactly. Pure — drives both the persisted `scalpingRiskPreset` label
 * (recomputed on every manual edit) and the UI's selected card.
 */
export function detectPreset(
  config: Pick<ScalpingConfig, "minAiConfidence">,
  risk: ScalpingRiskConfig,
): ScalpingPresetKey | "custom" {
  for (const key of Object.keys(SCALPING_PRESETS) as ScalpingPresetKey[]) {
    const preset = SCALPING_PRESETS[key];
    const configMatch = preset.config.minAiConfidence === undefined
      || preset.config.minAiConfidence === config.minAiConfidence;
    const riskMatch = PRESET_RISK_FIELDS.every((field) =>
      preset.risk[field] === undefined || eq(preset.risk[field], risk[field]));
    if (configMatch && riskMatch) return key;
  }
  return "custom";
}

/** Hard total-exposure ceiling (%) for the active preset / custom. */
export function exposureCapPct(preset: ScalpingPresetKey | "custom"): number {
  return EXPOSURE_CAP_PCT[preset] ?? EXPOSURE_CAP_PCT.custom;
}

/**
 * Config-level exposure check: does this risk config's worst-case open risk
 * (maxOpen × riskPerTradePercent) breach its preset cap? Only applies in
 * risk-percent lot mode. Used at save-time to reject unsafe configs.
 */
export function totalExposureExceedsCapForRisk(
  risk: Pick<ScalpingRiskConfig, "lotMode" | "maxOpenTradesTotal" | "riskPerTradePercent" | "scalpingRiskPreset">,
): boolean {
  if (risk.lotMode !== "risk_percent") return false;
  const cap = exposureCapPct(risk.scalpingRiskPreset);
  return risk.maxOpenTradesTotal * risk.riskPerTradePercent > cap + 1e-9;
}
