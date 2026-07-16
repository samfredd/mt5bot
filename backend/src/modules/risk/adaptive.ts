import type { RiskSettings } from "@prisma/client";
import type { AiDecision, TradeJudgment } from "../ai/schema.js";
import type { TradingInstrumentSpec } from "./instruments.js";

export interface CapitalProfile {
  enabled: boolean;
  tier: string;
  equity: number;
  maxRiskPerTradePct: number;
  maxLotSize: number;
  maxOpenTrades: number;
  maxTradesPerSymbol: number;
  maxTradesPerDay: number;
}

const tierFor = (equity: number) => {
  if (equity < 500) return { tier: "micro", risk: 0.25, lots: 0.03, open: 1, perSymbol: 1, perDay: 3 };
  if (equity < 2_000) return { tier: "small", risk: 0.5, lots: 0.1, open: 2, perSymbol: 1, perDay: 5 };
  if (equity < 10_000) return { tier: "growth", risk: 0.75, lots: 0.3, open: 3, perSymbol: 1, perDay: 8 };
  if (equity < 50_000) return { tier: "standard", risk: 1, lots: 1, open: 5, perSymbol: 2, perDay: 10 };
  return { tier: "large", risk: 1, lots: 2, open: 6, perSymbol: 2, perDay: 12 };
};

/** Runtime-only capital limits. User settings remain hard ceilings. */
export function adaptiveRiskSettings(settings: RiskSettings, equity: number, enabled: boolean): {
  settings: RiskSettings;
  profile: CapitalProfile;
} {
  const tier = tierFor(Math.max(0, equity));
  const effective = enabled ? {
    ...settings,
    maxRiskPerTradePct: Math.min(settings.maxRiskPerTradePct, tier.risk),
    maxLotSize: Math.min(settings.maxLotSize, tier.lots),
    maxOpenTrades: Math.min(settings.maxOpenTrades, tier.open),
    maxTradesPerSymbol: Math.min(settings.maxTradesPerSymbol, tier.perSymbol),
    maxTradesPerDay: Math.min(settings.maxTradesPerDay, tier.perDay),
  } : settings;
  return {
    settings: effective,
    profile: {
      enabled,
      tier: enabled ? tier.tier : "manual",
      equity,
      maxRiskPerTradePct: effective.maxRiskPerTradePct,
      maxLotSize: effective.maxLotSize,
      maxOpenTrades: effective.maxOpenTrades,
      maxTradesPerSymbol: effective.maxTradesPerSymbol,
      maxTradesPerDay: effective.maxTradesPerDay,
    },
  };
}

export interface AiSizingResult {
  baseLots: number;
  lots: number;
  scalePercent: number;
  source: "pure_logic" | "ai" | "deterministic";
}

/** AI can reduce the equity-sized amount, but can never increase it. */
export function applyAiLotSizing(input: {
  baseLots: number;
  direction: "buy" | "sell";
  decision: AiDecision;
  judgment: TradeJudgment | null;
  instrument: TradingInstrumentSpec;
  enabled: boolean;
  pureLogic: boolean;
}): AiSizingResult {
  if (!input.enabled || input.pureLogic || input.decision.decision !== input.direction) {
    return { baseLots: input.baseLots, lots: input.baseLots, scalePercent: 100, source: input.pureLogic ? "pure_logic" : "deterministic" };
  }
  const requested = input.judgment?.position_size_percent ?? input.decision.confidence * 100;
  const riskScale = input.decision.risk_level === "high" ? 50 : input.decision.risk_level === "medium" ? 75 : 100;
  const scalePercent = Math.max(0, Math.min(100, requested, riskScale));
  const step = Math.max(input.instrument.volumeStep, 0.00000001);
  const min = Math.max(input.instrument.volumeMin, step);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const scaled = Math.floor((input.baseLots * scalePercent / 100 + step * 1e-9) / step) * step;
  const lots = Number(Math.min(input.baseLots, Math.max(min, scaled)).toFixed(decimals));
  return { baseLots: input.baseLots, lots, scalePercent, source: "ai" };
}
