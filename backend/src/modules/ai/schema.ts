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
