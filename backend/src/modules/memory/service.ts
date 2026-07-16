import type { TradeDirection } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { getOperationalConfig } from "../system/operational-config.js";

type JsonObject = Record<string, unknown>;

export interface MemoryQuery {
  userId: string;
  symbol: string;
  strategyId?: string | null;
  direction?: "buy" | "sell";
  source?: string;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
}

function outcomeFor(profit: number): "WIN" | "LOSS" | "BREAKEVEN" {
  if (profit > 0.01) return "WIN";
  if (profit < -0.01) return "LOSS";
  return "BREAKEVEN";
}

function sourceFor(explanation: JsonObject, strategyName: string | null): string {
  return text(explanation.source)
    ?? (explanation.scanner === true ? "AUTONOMOUS_SCANNER" : null)
    ?? (explanation.manual === true ? "MANUAL" : null)
    ?? (strategyName ? `STRATEGY:${strategyName}` : "SYSTEM");
}

function rMultiple(input: {
  direction: TradeDirection;
  entryPrice: number | null;
  stopLoss: number | null;
  exitPrice: number | null;
}): number | null {
  if (input.entryPrice === null || input.stopLoss === null || input.exitPrice === null) return null;
  const initialRisk = Math.abs(input.entryPrice - input.stopLoss);
  if (!(initialRisk > 0)) return null;
  const move = input.direction === "BUY" ? input.exitPrice - input.entryPrice : input.entryPrice - input.exitPrice;
  return Number((move / initialRisk).toFixed(3));
}

export async function learnFromClosedTrade(tradeId: string): Promise<boolean> {
  const settings = await getOperationalConfig();
  if (!settings.tradingMemoryEnabled) return false;
  const trade = await prisma.trade.findUnique({ where: { id: tradeId }, include: { strategy: { select: { name: true } } } });
  if (!trade || trade.status !== "CLOSED" || trade.profit === null) return false;

  const explanation = object(trade.explanation);
  const ai = object(explanation.ai);
  const context = object(explanation.context);
  const confidenceEngine = object(context.confidenceEngine);
  const news = object(explanation.news);
  const outcome = outcomeFor(trade.profit);
  const aiConfidence = number(ai.confidence);
  const marketRegime = text(context.marketRegime) ?? text(ai.marketRegime);
  const newsRisk = text(news.level) ?? text(ai.news_risk);
  const closeReason = text(explanation.closeReason);
  const conflicts = list(confidenceEngine.conflicts);
  const reasonsAgainst = list(ai.reasonsAgainst);
  const mistakes: string[] = [];
  const strengths: string[] = [];

  if (outcome === "LOSS") {
    if (aiConfidence !== null && aiConfidence >= 0.75) mistakes.push(`High-confidence approval (${Math.round(aiConfidence * 100)}%) still lost; calibrate confidence downward for similar setups.`);
    if (newsRisk && /high/i.test(newsRisk)) mistakes.push("The trade lost with high news risk; require stronger confirmation or hold around similar events.");
    if (conflicts.length) mistakes.push(`Conflicting evidence was present: ${conflicts.slice(0, 3).join("; ")}.`);
    if (reasonsAgainst.length) mistakes.push(`The pre-trade counter-case mattered: ${reasonsAgainst.slice(0, 2).join("; ")}.`);
    if (!mistakes.length) mistakes.push("This setup lost; require stronger current-market confirmation before repeating the same symbol/direction/source combination.");
  } else if (outcome === "WIN") {
    if (marketRegime) strengths.push(`The setup worked in the ${marketRegime} regime.`);
    if (aiConfidence !== null) strengths.push(`The pre-trade AI confidence was ${Math.round(aiConfidence * 100)}%.`);
    strengths.push("Treat this as supporting evidence only after repeated independent samples; never copy the old trade without current confirmation.");
  } else {
    mistakes.push("The trade produced no meaningful edge after costs; avoid repeating it without improved reward-to-risk or stronger confirmation.");
  }

  const source = sourceFor(explanation, trade.strategy?.name ?? null);
  const lesson = outcome === "WIN"
    ? `${trade.symbol} ${trade.direction.toLowerCase()} via ${source} won ${trade.profit.toFixed(2)}. Preserve the conditions that aligned, but demand fresh evidence.`
    : outcome === "LOSS"
      ? `${trade.symbol} ${trade.direction.toLowerCase()} via ${source} lost ${Math.abs(trade.profit).toFixed(2)}. Reduce confidence for a similar setup unless the identified weaknesses are resolved.`
      : `${trade.symbol} ${trade.direction.toLowerCase()} via ${source} broke even. Costs consumed the edge; demand a clearer setup.`;

  const created = await prisma.tradingMemory.upsert({
    where: { tradeId: trade.id },
    create: {
      userId: trade.userId,
      tradeId: trade.id,
      symbol: trade.symbol.toUpperCase(),
      direction: trade.direction,
      strategyId: trade.strategyId,
      strategyName: trade.strategy?.name ?? null,
      source,
      outcome,
      profit: trade.profit,
      rMultiple: rMultiple({ direction: trade.direction, entryPrice: trade.entryPrice, stopLoss: trade.stopLoss, exitPrice: trade.brokerExitPrice }),
      aiDecision: text(ai.decision),
      aiConfidence,
      marketRegime,
      newsRisk,
      closeReason,
      lesson,
      mistakes,
      strengths,
      context: {
        mode: trade.mode,
        accountId: trade.accountId,
        conflicts,
        reasonsAgainst,
        risk: explanation.risk ?? null,
        capitalSizing: explanation.capitalSizing ?? null,
      },
    },
    update: {
      outcome,
      profit: trade.profit,
      rMultiple: rMultiple({ direction: trade.direction, entryPrice: trade.entryPrice, stopLoss: trade.stopLoss, exitPrice: trade.brokerExitPrice }),
      closeReason,
      lesson,
      mistakes,
      strengths,
    },
    select: { createdAt: true, updatedAt: true },
  });
  if (created.createdAt.getTime() === created.updatedAt.getTime()) {
    await audit({ actor: "system:trading-memory", userId: trade.userId, category: "ai", action: "trade_lesson_learned", detail: { tradeId, symbol: trade.symbol, outcome, profit: trade.profit } });
  }
  return true;
}

export async function backfillTradeMemories(userId?: string, limit = 100): Promise<number> {
  const rows = await prisma.trade.findMany({
    where: { ...(userId ? { userId } : {}), status: "CLOSED", profit: { not: null }, memoryEntry: null },
    orderBy: { closedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 500),
    select: { id: true },
  });
  let learned = 0;
  for (const row of rows) if (await learnFromClosedTrade(row.id)) learned++;
  return learned;
}

export async function memorySummary(userId: string) {
  const rows = await prisma.tradingMemory.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 500 });
  const wins = rows.filter((row) => row.outcome === "WIN");
  const losses = rows.filter((row) => row.outcome === "LOSS");
  const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0);
  const bySymbol = new Map<string, { trades: number; wins: number; profit: number }>();
  for (const row of rows) {
    const item = bySymbol.get(row.symbol) ?? { trades: 0, wins: 0, profit: 0 };
    item.trades++; if (row.outcome === "WIN") item.wins++; item.profit += row.profit;
    bySymbol.set(row.symbol, item);
  }
  return {
    total: rows.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: rows.length - wins.length - losses.length,
    winRate: rows.length ? Number((wins.length / rows.length).toFixed(3)) : null,
    totalProfit: Number(totalProfit.toFixed(2)),
    symbols: [...bySymbol.entries()].map(([symbol, item]) => ({ symbol, ...item, winRate: Number((item.wins / item.trades).toFixed(3)), profit: Number(item.profit.toFixed(2)) })).sort((a, b) => b.trades - a.trades).slice(0, 12),
    recent: rows.slice(0, 20).map((row) => ({ id: row.id, tradeId: row.tradeId, symbol: row.symbol, direction: row.direction, strategyName: row.strategyName, source: row.source, outcome: row.outcome, profit: row.profit, rMultiple: row.rMultiple, lesson: row.lesson, mistakes: row.mistakes, strengths: row.strengths, createdAt: row.createdAt })),
  };
}

export async function relevantMemory(query: MemoryQuery): Promise<string> {
  const settings = await getOperationalConfig();
  if (!settings.tradingMemoryEnabled) return "";
  const rows = await prisma.tradingMemory.findMany({
    where: { userId: query.userId },
    orderBy: { createdAt: "desc" },
    take: settings.tradingMemoryLookbackTrades,
  });
  if (!rows.length) return "";
  const direction = query.direction?.toUpperCase();
  const scored = rows.map((row) => ({
    row,
    score: (row.symbol === query.symbol.toUpperCase() ? 5 : 0)
      + (query.strategyId && row.strategyId === query.strategyId ? 4 : 0)
      + (direction && row.direction === direction ? 2 : 0)
      + (query.source && row.source.toLowerCase().includes(query.source.toLowerCase()) ? 2 : 0),
  })).sort((a, b) => b.score - a.score || b.row.createdAt.getTime() - a.row.createdAt.getTime());
  const relevant = scored.filter((item) => item.score > 0).slice(0, 30).map((item) => item.row);
  if (relevant.length < settings.tradingMemoryMinSamples) return `EMPIRICAL TRADING MEMORY: only ${relevant.length} relevant completed trade(s); sample is below the ${settings.tradingMemoryMinSamples}-trade minimum, so do not infer an edge.`;
  const wins = relevant.filter((row) => row.outcome === "WIN").length;
  const pnl = relevant.reduce((sum, row) => sum + row.profit, 0);
  const losses = relevant.filter((row) => row.outcome === "LOSS").slice(0, 3);
  const successes = relevant.filter((row) => row.outcome === "WIN").slice(0, 3);
  return [
    "EMPIRICAL TRADING MEMORY (past outcomes, not current market facts):",
    `Relevant sample: ${relevant.length} trades; wins ${wins}; losses ${relevant.length - wins}; win rate ${Math.round((wins / relevant.length) * 100)}%; net P/L ${pnl.toFixed(2)}.`,
    ...losses.map((row) => `Mistake to avoid: ${row.lesson} ${list(row.mistakes).join(" ")}`),
    ...successes.map((row) => `Prior strength: ${row.lesson} ${list(row.strengths).join(" ")}`),
    "Use memory only to calibrate confidence, reduce size, or HOLD. It can never replace current evidence, justify missing data, widen risk, or override the deterministic risk engine.",
  ].join("\n");
}
