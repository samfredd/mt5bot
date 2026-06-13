import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { askModel } from "../ai/service.js";
import { buildTraderEvaluationPrompt } from "../ai/prompts.js";
import { mt5 } from "../mt5/client.js";
import { assessNewsRisk } from "../news/service.js";
import { calculateLots, countConsecutiveLosses, validateTrade, type TradeProposal } from "../risk/engine.js";
import { buildRiskContext, executeTrade, sessionNow } from "../trading/service.js";
import { notify } from "../notifications/service.js";
import type { CopyTrader, User } from "@prisma/client";

export interface TraderMetrics {
  winRate: number;            // 0..100
  profitFactor: number;
  maxDrawdownPct: number;
  avgMonthlyReturnPct: number;
  consistency: number;        // 0..100
  accountAgeMonths: number;
  tradesPerWeek: number;
  avgTradeDurationHours: number;
  maxLossStreak: number;
  recoveryBehavior: "good" | "average" | "poor";
  symbolSpecialization: string[];
  lotBehavior: "consistent" | "variable" | "martingale";
  newsBehavior: "avoids" | "trades_through";
}

/**
 * Deterministic risk score (0 = safest, 100 = most dangerous). The AI gets
 * the same metrics for a qualitative second opinion, but this score is what
 * the automated stop-copy rules act on.
 */
export function scoreTrader(m: TraderMetrics): { score: number; flags: string[] } {
  let score = 50;
  const flags: string[] = [];
  if (m.winRate >= 55) score -= 8; else if (m.winRate < 40) { score += 10; flags.push("low win rate"); }
  if (m.profitFactor >= 1.5) score -= 10; else if (m.profitFactor < 1.1) { score += 15; flags.push("weak profit factor"); }
  if (m.maxDrawdownPct > 30) { score += 15; flags.push("deep historical drawdown"); } else if (m.maxDrawdownPct < 10) score -= 8;
  if (m.consistency >= 70) score -= 7; else if (m.consistency < 40) { score += 8; flags.push("inconsistent returns"); }
  if (m.accountAgeMonths < 6) { score += 10; flags.push("young account"); } else if (m.accountAgeMonths >= 24) score -= 7;
  if (m.maxLossStreak > 8) { score += 8; flags.push("long loss streaks"); }
  if (m.recoveryBehavior === "poor") { score += 10; flags.push("poor recovery after losses"); }
  if (m.lotBehavior === "martingale") { score += 25; flags.push("martingale lot sizing — high blow-up risk"); }
  else if (m.lotBehavior === "consistent") score -= 5;
  if (m.newsBehavior === "trades_through") { score += 5; flags.push("trades through high-impact news"); }
  return { score: Math.max(0, Math.min(100, score)), flags };
}

/** AI + deterministic evaluation, with a written explanation of the verdict. */
export async function evaluateTrader(trader: CopyTrader) {
  const metrics = trader.metrics as unknown as TraderMetrics;
  const { score, flags } = scoreTrader(metrics);
  const { decision } = await askModel(buildTraderEvaluationPrompt(metrics as unknown as Record<string, unknown>), `copy:${trader.name}`);
  const recommend = score < 45 && decision.decision === "buy";
  const explanation = [
    `Risk score ${score}/100 (lower is safer).`,
    flags.length ? `Flags: ${flags.join("; ")}.` : "No major red flags.",
    `AI verdict: ${decision.decision === "buy" ? "recommend" : "do not copy"} (confidence ${decision.confidence}) — ${decision.reasoning}`,
  ].join("\n");
  await prisma.copyTrader.update({ where: { id: trader.id }, data: { riskScore: score } });
  await audit({ actor: "system", userId: trader.userId, category: "copy", action: "trader_evaluated", detail: { traderId: trader.id, score, recommend, flags } });
  return { score, flags, recommend, explanation };
}

interface CopyRules {
  lotMultiplier?: number;
  fixedLot?: number;
  maxRiskPerCopiedTradePct?: number;
  symbolsAllowed?: string[];
  symbolsBlocked?: string[];
  stopAfterDrawdownPct?: number;
  stopAfterLossStreak?: number;
  maxSourceLot?: number;
}

/**
 * Mirror one source trade. Copy trades go through the SAME risk engine as
 * everything else — copy mode is never a bypass. Source lots are optional:
 * human signals often omit size, in which case we size from risk settings.
 */
export async function copySourceTrade(
  user: User,
  trader: CopyTrader,
  source: { symbol: string; direction: "buy" | "sell"; lots?: number; sl?: number; tp?: number; ref?: string },
) {
  const rules = (trader.copyRules ?? {}) as CopyRules;

  if (rules.symbolsAllowed?.length && !rules.symbolsAllowed.includes(source.symbol)) {
    return reject(user, trader, source, `symbol ${source.symbol} not in allowed list`);
  }
  if (rules.symbolsBlocked?.includes(source.symbol)) {
    return reject(user, trader, source, `symbol ${source.symbol} is blocked`);
  }
  if (rules.maxSourceLot && source.lots !== undefined && source.lots > rules.maxSourceLot) {
    return reject(user, trader, source, `abnormal source lot size ${source.lots} (max ${rules.maxSourceLot}) — possible martingale`);
  }

  // Stop-copy guards based on recent copied performance.
  const recent = await prisma.trade.findMany({
    where: { userId: user.id, mode: "COPY", copiedTrade: { copyTraderId: trader.id }, status: "CLOSED" },
    orderBy: { closedAt: "desc" }, take: 20,
  });
  const streak = countConsecutiveLosses(recent);
  if (rules.stopAfterLossStreak && streak >= rules.stopAfterLossStreak) {
    await prisma.copyTrader.update({ where: { id: trader.id }, data: { active: false } });
    await notify(user.id, "copy_update", `Stopped copying ${trader.name}`, `Loss streak of ${streak} hit the configured limit.`);
    return reject(user, trader, source, `auto-stopped: loss streak ${streak}`);
  }

  const tick = await mt5.tick(source.symbol);
  const entry = source.direction === "buy" ? tick.ask : tick.bid;

  const settings = await prisma.riskSettings.findUnique({ where: { userId: user.id } });
  if (!settings) return reject(user, trader, source, "no risk settings configured");

  // Sizing priority: fixed lot rule → mirror source lots × multiplier →
  // risk-based from the signal's stop distance → minimum lot.
  let lots: number;
  if (rules.fixedLot) {
    lots = rules.fixedLot;
  } else if (source.lots !== undefined) {
    lots = Math.max(0.01, Math.round(source.lots * (rules.lotMultiplier ?? 1) * 100) / 100);
  } else if (source.sl) {
    const account0 = await mt5.accountInfo();
    const riskPct = rules.maxRiskPerCopiedTradePct ?? settings.maxRiskPerTradePct;
    lots = calculateLots(source.symbol, account0.balance, riskPct, entry, source.sl, settings.maxLotSize);
  } else {
    lots = 0.01;
  }
  const news = await assessNewsRisk(source.symbol, settings);
  const account = await mt5.accountInfo();

  const proposal: TradeProposal = {
    symbol: source.symbol, direction: source.direction, lots, entry,
    stopLoss: source.sl ?? null, takeProfit: source.tp ?? null, isCopyTrade: true,
  };
  const ctx = await buildRiskContext(user, settings, account, tick.spread_points, null, sessionNow(), news.action, { isCopy: true });
  const risk = validateTrade(proposal, ctx);
  if (!risk.ok) {
    const failed = risk.checks.filter((c) => !c.passed).map((c) => c.name).join(", ");
    return reject(user, trader, source, `risk engine blocked copy trade: ${failed}`);
  }
  proposal.lots = risk.adjustedLots ?? proposal.lots;

  const trade = await executeTrade(user, proposal, {
    explanation: { copy: { trader: trader.name, sourceRef: source.ref, rules }, risk: { checks: risk.checks } },
    mode: "COPY", actor: `copy:${trader.name}`,
  });
  if (trade.status === "EXECUTED") {
    await prisma.copiedTrade.create({ data: { copyTraderId: trader.id, tradeId: trade.id, sourceRef: source.ref } });
  }
  return trade;
}

async function reject(user: User, trader: CopyTrader, source: { symbol: string }, reason: string) {
  await audit({ actor: `copy:${trader.name}`, userId: user.id, category: "copy", action: "copy_rejected", detail: { symbol: source.symbol, reason } });
  return null;
}
