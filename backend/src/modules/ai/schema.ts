import { z } from "zod";

/**
 * Contract for every AI response. Anything that fails this schema is
 * discarded and treated as "avoid". The AI is a reasoning layer ONLY —
 * `should_execute` is advisory and is re-checked by the risk engine;
 * it can veto a trade but never force one.
 */
export const AiDecisionSchema = z.object({
  decision: z.enum(["buy", "sell", "hold", "avoid"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(4000),
  risk_level: z.enum(["low", "medium", "high"]),
  suggested_entry: z.number().nullable().optional(),
  suggested_stop_loss: z.number().nullable().optional(),
  suggested_take_profit: z.number().nullable().optional(),
  news_risk: z.enum(["low", "medium", "high"]),
  should_execute: z.boolean(),
});

export type AiDecision = z.infer<typeof AiDecisionSchema>;

export const AI_SAFE_FALLBACK: AiDecision = {
  decision: "avoid",
  confidence: 0,
  reasoning: "AI response was missing or invalid; defaulting to avoid.",
  risk_level: "high",
  suggested_entry: null,
  suggested_stop_loss: null,
  suggested_take_profit: null,
  news_risk: "high",
  should_execute: false,
};

const boundedStrings = z.array(z.string().max(300)).max(12).catch([]);

/**
 * The trade-judge decision framework: what the model returns when judging a
 * pre-computed DecisionContext payload. Deliberately forgiving on optional
 * fields (small local models drop keys) but strict on the load-bearing core:
 * action, confidence and final_verdict must parse or the response is rejected
 * and the pipeline falls back to "avoid".
 */
export const TradeJudgmentSchema = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  confidence: z.number().min(0).max(100),
  position_size_percent: z.number().min(0).max(100).nullable().catch(null),
  stop_loss: z.number().nullable().catch(null),
  take_profit: z.number().nullable().catch(null),
  risk_reward_ratio: z.number().nullable().catch(null),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]).catch("MEDIUM"),
  reasons_for_trade: boundedStrings,
  reasons_against_trade: boundedStrings,
  trade_invalidators: boundedStrings,
  required_confirmations: boundedStrings,
  market_regime: z.string().max(60).catch(""),
  expected_holding_time: z.string().max(60).catch(""),
  missing_data: boundedStrings,
  final_verdict: z.string().min(1).max(600),
});

export type TradeJudgment = z.infer<typeof TradeJudgmentSchema>;

/**
 * Adapt a trade judgment to the legacy AiDecision every downstream consumer
 * (gating, explanation JSON, notifications, scalping cache) already speaks.
 * `news_risk` is deterministic elsewhere in the pipeline, so it mirrors the
 * judgment's risk level rather than pretending the model re-assessed news.
 */
export function judgmentToDecision(judgment: TradeJudgment): AiDecision {
  const decision = judgment.action === "BUY" ? "buy" : judgment.action === "SELL" ? "sell" : "hold";
  const parts = [
    judgment.final_verdict,
    judgment.reasons_for_trade.length ? `For: ${judgment.reasons_for_trade.join("; ")}` : "",
    judgment.reasons_against_trade.length ? `Against: ${judgment.reasons_against_trade.join("; ")}` : "",
    judgment.trade_invalidators.length ? `Invalidated by: ${judgment.trade_invalidators.join("; ")}` : "",
    judgment.required_confirmations.length ? `Needs: ${judgment.required_confirmations.join("; ")}` : "",
  ];
  const riskLevel = judgment.risk_level.toLowerCase() as "low" | "medium" | "high";
  return {
    decision,
    confidence: Number((judgment.confidence / 100).toFixed(2)),
    reasoning: parts.filter(Boolean).join(" | ").slice(0, 4000),
    risk_level: riskLevel,
    suggested_entry: null,
    suggested_stop_loss: judgment.stop_loss,
    suggested_take_profit: judgment.take_profit,
    news_risk: riskLevel,
    should_execute: judgment.action !== "HOLD",
  };
}

/**
 * Accept model-suggested SL/TP only when they are on the correct side of the
 * entry and within a sane ATR band; otherwise return null so the caller keeps
 * its own deterministic levels. A hallucinated-but-plausible number must never
 * silently replace an engineered one.
 */
export function clampSuggestedLevels(
  direction: "buy" | "sell",
  entry: number,
  atr: number | null,
  stopLoss: number | null | undefined,
  takeProfit: number | null | undefined,
): { stopLoss: number | null; takeProfit: number | null } {
  if (!atr || atr <= 0 || !Number.isFinite(entry) || entry <= 0) return { stopLoss: null, takeProfit: null };
  const validate = (level: number | null | undefined, side: "sl" | "tp", maxAtr: number): number | null => {
    if (level == null || !Number.isFinite(level) || level <= 0) return null;
    const belowEntry = level < entry;
    const correctSide = side === "sl" ? (direction === "buy" ? belowEntry : !belowEntry) : direction === "buy" ? !belowEntry : belowEntry;
    if (!correctSide) return null;
    const distAtr = Math.abs(entry - level) / atr;
    return distAtr >= 0.25 && distAtr <= maxAtr ? level : null;
  };
  return {
    stopLoss: validate(stopLoss, "sl", 6),
    takeProfit: validate(takeProfit, "tp", 12),
  };
}
