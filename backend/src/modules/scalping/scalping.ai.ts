import { askModelWithSystem, getActiveProvider, PURE_LOGIC_PROVIDER } from "../ai/service.js";
import type { AiDecision } from "../ai/schema.js";
import { mt5 } from "../mt5/client.js";
import { buildMarketAnalysis, type MarketAnalysis } from "../analysis/engine.js";
import { normalizeCandles } from "../backtest/market-data.js";
import { scoreSymbol } from "../trading/scanner.js";
import { audit, logError } from "../../lib/audit.js";
import type { ScalpingConfig } from "./scalping.schema.js";
import { aiFireControlActive } from "./scalping.types.js";
import type { ScalpingAiDecision } from "./scalping.types.js";
import { prisma } from "../../lib/prisma.js";
import { getOperationalConfig } from "../system/operational-config.js";

/**
 * Scalping AI "fire control".
 *
 * The AI is NOT called every second. Instead this module evaluates each symbol
 * at most once per `aiDecisionTtlSeconds`, caching a {technical direction + AI
 * permit} plan per symbol. The 1-second worker reads the cache only. The AI
 * never originates a trade — the technical read picks the direction; the AI only
 * permits or blocks firing in that direction (see {@link aiPermitsFire}).
 */

const SCALPING_SYSTEM_PROMPT = `You are the FIRE-CONTROL gate of a high-frequency, money-target scalping engine. You CANNOT execute trades — a separate risk engine validates everything and can override you. A fast technical signal has ALREADY chosen a direction; your only job is to PERMIT or BLOCK an immediate, very small scalp in that direction.

This is scalping, NOT swing trading: do NOT demand multi-bar setups or 2:1 reward — exits are managed by tiny fixed money targets, not price structure. Judge only what matters for the next few seconds:
1. MICRO-MOMENTUM: do the fastest timeframes (M1/M5) lean the proposed direction right now?
2. SPREAD/LIQUIDITY: is the spread tight enough that a micro-target is reachable? Wide spread = block.
3. NOISE/REVERSAL: is price slamming into an obvious M5 level against the trade, or whipsawing? If so, block.

Rules:
- To PERMIT, set "decision" EQUAL to the proposed direction ("buy" or "sell").
- To BLOCK, return "hold" (no edge right now) or "avoid" (actively dangerous: spread blowout, imminent reversal, illiquid).
- Calibrate confidence honestly: 0.72+ means you would fire this micro-scalp now.
- Leave suggested_entry / suggested_stop_loss / suggested_take_profit as null — exits are money-based.

Respond with ONLY a single JSON object, no markdown:
{
  "decision": "buy | sell | hold | avoid",
  "confidence": 0.0,
  "reasoning": "micro-momentum + spread read in one or two sentences",
  "risk_level": "low | medium | high",
  "suggested_entry": null,
  "suggested_stop_loss": null,
  "suggested_take_profit": null,
  "news_risk": "low | medium | high",
  "should_execute": false
}`;

export function buildScalpingPrompt(analysis: MarketAnalysis, direction: "buy" | "sell"): string {
  return [
    `SCALP CANDIDATE — proposed direction: ${direction.toUpperCase()}`,
    `Symbol: ${analysis.symbol} | Session: ${analysis.session} | Spread: ${analysis.spreadPoints} points | Bid/Ask: ${analysis.bid}/${analysis.ask}`,
    ``,
    `FAST TECHNICALS (per timeframe):`,
    JSON.stringify(analysis.timeframes, null, 1),
    ``,
    `Decide whether to PERMIT an immediate ${direction.toUpperCase()} micro-scalp. Respond with the JSON object only.`,
  ].join("\n");
}

export interface ScalpingPlan {
  symbol: string;
  direction: "buy" | "sell" | null;
  score: number;
  reasons: string[];
  ai: ScalpingAiDecision | null;
  computedAt: number;
  validUntil: number;
}

const planCache = new Map<string, ScalpingPlan>();
const decisionHistory: ScalpingAiDecision[] = [];

function key(symbol: string): string {
  return symbol.toUpperCase();
}

function toScalpingDecision(
  symbol: string,
  ai: AiDecision,
  logId: string | null,
  valid: boolean,
  ttlSeconds: number,
): ScalpingAiDecision {
  return {
    symbol: symbol.toUpperCase(),
    decision: ai.decision,
    confidence: ai.confidence,
    riskLevel: ai.risk_level,
    shouldExecute: ai.should_execute,
    reasoning: ai.reasoning,
    validUntil: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    aiDecisionId: logId,
    valid,
  };
}

/** Cached plan for a symbol, or null when missing/expired (1s worker reads this). */
export function getCachedPlan(symbol: string): ScalpingPlan | null {
  const plan = planCache.get(key(symbol));
  if (!plan) return null;
  return plan.validUntil > Date.now() ? plan : null;
}

export function getScalpingPlans(): ScalpingPlan[] {
  return [...planCache.values()];
}

export function getRecentScalpingDecisions(limit = 25): ScalpingAiDecision[] {
  return decisionHistory.slice(0, limit);
}

/** Test/reset hook. */
export function clearScalpingPlans(): void {
  planCache.clear();
  decisionHistory.length = 0;
}

/**
 * Recompute one symbol's plan: pull fast candles, derive a technical direction
 * (reusing the scanner's confluence scorer), and — only when AI fire control is
 * on and there IS a direction — ask the model to permit/block. Caches the plan
 * for `aiDecisionTtlSeconds`.
 */
export async function refreshPlan(symbol: string, config: ScalpingConfig): Promise<ScalpingPlan> {
  const tick = await mt5.tick(symbol);
  const tickTime = Date.parse(tick.time);
  const candlesByTf = {
    M1: normalizeCandles(await mt5.candles(symbol, "M1", 201), "M1", tickTime).slice(-200),
    M5: normalizeCandles(await mt5.candles(symbol, "M5", 201), "M5", tickTime).slice(-200),
  };
  const analysis = buildMarketAnalysis(symbol, tick, candlesByTf);
  const scored = scoreSymbol(analysis);
  const direction = scored.direction;

  let ai: ScalpingAiDecision | null = null;
  if ((await getActiveProvider()) !== PURE_LOGIC_PROVIDER && aiFireControlActive(config) && direction) {
    const prompt = buildScalpingPrompt(analysis, direction);
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
    const { decision, logId, valid } = await askModelWithSystem(
      SCALPING_SYSTEM_PROMPT,
      prompt,
      symbol,
      admin ? { userId: admin.id, direction, source: "scalping" } : undefined,
    );
    ai = toScalpingDecision(symbol, decision, logId, valid, config.aiDecisionTtlSeconds);
    decisionHistory.unshift(ai);
    const { scalpingDecisionHistoryLimit } = await getOperationalConfig();
    decisionHistory.length = Math.min(decisionHistory.length, scalpingDecisionHistoryLimit);
    // Emit each fire-control verdict to the live activity feed. Frequency is
    // bounded by the per-symbol TTL (default 60s), so this does not spam.
    await audit({
      actor: "scalping:ai", category: "ai", action: "scalp_ai_decision",
      detail: { symbol: symbol.toUpperCase(), direction, decision: ai.decision, confidence: ai.confidence, riskLevel: ai.riskLevel, valid: ai.valid, reasoning: ai.reasoning.slice(0, 160) },
    });
  }

  const plan: ScalpingPlan = {
    symbol: symbol.toUpperCase(),
    direction,
    score: scored.score,
    reasons: scored.reasons,
    ai,
    computedAt: Date.now(),
    validUntil: Date.now() + config.aiDecisionTtlSeconds * 1000,
  };
  planCache.set(key(symbol), plan);
  return plan;
}

/** Refresh every watchlist symbol whose cached plan is missing or expired. */
export async function refreshStalePlans(config: ScalpingConfig): Promise<{ refreshed: number; errors: string[] }> {
  let refreshed = 0;
  const errors: string[] = [];
  for (const symbol of config.symbols) {
    if (getCachedPlan(symbol)) continue;
    try {
      await refreshPlan(symbol, config);
      refreshed++;
    } catch (err) {
      const msg = `${symbol}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      await logError("scalping-ai", "plan refresh failed", { symbol, error: String(err) });
    }
  }
  return { refreshed, errors };
}
