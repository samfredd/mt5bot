import type { ScalpingConfig, ScalpingRiskConfig } from "./scalping.schema.js";

export type { ScalpingConfig, ScalpingRiskConfig } from "./scalping.schema.js";

/**
 * Tag stamped into every scalping trade's `explanation` JSON. This is how
 * scalping trades are distinguished from normal strategy/scanner/manual trades
 * WITHOUT a schema change — queries filter on `explanation.source`. Reusing the
 * existing `Trade` model keeps the normal pipeline completely untouched.
 */
export const SCALPING_SOURCE = "SCALPING_MODE" as const;
export const SCALPING_STRATEGY_NAME = "Multi-Pair Sequential Scalper" as const;

/** Why a scalping position was closed — recorded in the trade explanation. */
export const SCALP_CLOSE_REASONS = [
  "SCALP_TP_MONEY",
  "SCALP_MAX_LOSS_MONEY",
  "SCALP_PROFIT_TARGET",
  "SCALP_NEWS_FLATTEN",
  "SCALP_EQUITY_GUARDIAN",
  "SCALP_MANUAL_CLOSE",
  "SCALP_SESSION_END",
] as const;
export type ScalpCloseReason = (typeof SCALP_CLOSE_REASONS)[number];

export type ScalpingStatus = "running" | "paused" | "stopped";

/** Structured AI verdict for one symbol — the scalping "fire control" gate. */
export interface ScalpingAiDecision {
  symbol: string;
  decision: "buy" | "sell" | "avoid" | "hold";
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  shouldExecute: boolean;
  reasoning: string;
  /** ISO timestamp; the cached decision is reused until this moment. */
  validUntil: string;
  /** AiAnalysisLog id for replay/auditing (null if the call could not be logged). */
  aiDecisionId: string | null;
  /** False when the model was unreachable/invalid — STRICT mode fails closed. */
  valid: boolean;
}

export const DEFAULT_SCALPING_CONFIG: ScalpingConfig = {
  enabled: false,
  status: "stopped",
  symbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"],
  useAiFireControl: true,
  aiMode: "STRICT",
  minAiConfidence: 0.72,
  aiDecisionTtlSeconds: 60,
};

export const DEFAULT_SCALPING_RISK: ScalpingRiskConfig = {
  scalpingRiskPreset: "custom",
  maxOpenTradesTotal: 5,
  maxTradesPerSymbol: 1,
  stopBasis: "money",
  targetProfitMoney: 0.2,
  maxLossMoney: 0.05,
  takeProfitPoints: null,
  stopLossPoints: null,
  maxLotSize: 0.01,
  lotMode: "fixed",
  riskPerTradePercent: 0.5,
  allowFixedLot: true,
  profitTargetMoney: null,
  reentryAfterWinSeconds: 1,
  reentryAfterLossSeconds: 60,
  maxTradesPerDay: 100,
  maxConsecutiveLosses: 3,
  pauseAfterLossStreakMinutes: 10,
  dailyLossLimitMoney: null,
  dailyLossLimitPercent: 1.5,
  maxSharedCurrencyExposure: 2,
  maxSpreadPointsBySymbol: { EURUSD: 15, GBPUSD: 20, USDJPY: 18, AUDUSD: 20, USDCAD: 22 },
  allowedSessions: ["london", "newyork", "newyork_overlap"],
  pauseDuringNews: true,
  pauseBeforeNewsMin: 15,
  pauseAfterNewsMin: 5,
  newsRiskLimit: "HIGH",
  flattenBeforeHighImpactNews: false,
};

/** Minimal view of a closed scalping trade used by the pure cooldown/streak logic. */
export interface ClosedScalp {
  symbol: string;
  profit: number | null;
  closedAt: Date;
}

/** Minimal view of an active scalping trade/position used by the pure gate logic. */
export interface ActiveScalp {
  symbol: string;
  ticket: string | null;
}

export interface ScalpExplanation {
  source: typeof SCALPING_SOURCE;
  strategyName: typeof SCALPING_STRATEGY_NAME;
  aiDecisionId: string | null;
  scalpingRiskSnapshot: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Whether the LLM fire-control gate is active for this config. When false the
 * engine runs PURE LOGIC — technical signal + risk gates only, no model call.
 * Two ways to get there: the explicit `PURE_LOGIC` mode, or the legacy
 * `useAiFireControl: false` master switch. Centralised so the plan refresh
 * (skip the AI call) and the gate (always permit) can never drift apart.
 */
export function aiFireControlActive(
  config: Pick<ScalpingConfig, "useAiFireControl" | "aiMode">,
): boolean {
  return config.useAiFireControl && config.aiMode !== "PURE_LOGIC";
}

/** True when a trade's explanation marks it as a scalping-mode trade. */
export function isScalpingTrade(explanation: unknown): boolean {
  return (
    typeof explanation === "object" &&
    explanation !== null &&
    (explanation as { source?: unknown }).source === SCALPING_SOURCE
  );
}
