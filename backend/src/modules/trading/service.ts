import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { buildMarketAnalysis } from "../analysis/engine.js";
import { assessNewsRisk } from "../news/service.js";
import { evaluateStrategy, deriveLevels } from "../strategy/service.js";
import { askModel } from "../ai/service.js";
import { buildTradePrompt } from "../ai/prompts.js";
import { calculateLots, validateTrade, type RiskContext, type TradeProposal } from "../risk/engine.js";
import { getBotState } from "../system/state.js";
import { notify } from "../notifications/service.js";
import { broadcast } from "../ws/hub.js";
import type { Strategy, User } from "@prisma/client";

const APPROVAL_TTL_MIN = 15;

/**
 * Full evaluation pipeline for one symbol under one strategy. This is the
 * ONLY path that can lead to a new position:
 *
 *   market data → analysis engine → news gate → strategy signal
 *   → AI reasoning (advisory, can only veto) → risk engine (final authority)
 *   → mode gate (manual: notify / semi: approval / auto: execute)
 *
 * Every step is recorded in the trade's `explanation` for auditability.
 */
export async function evaluateAndMaybeTrade(user: User, strategy: Strategy, symbol: string) {
  const state = await getBotState();
  if (state.emergencyStop || state.status !== "running") return null;

  const settings = await prisma.riskSettings.findUnique({ where: { userId: user.id } });
  if (!settings) {
    await audit({ actor: "system", userId: user.id, category: "risk", action: "missing_risk_settings", detail: { symbol } });
    return null;
  }

  // 1. Market data + technical analysis
  const tick = await mt5.tick(symbol);
  const cfg = strategy.config as { timeframes?: string[] };
  const timeframes = cfg.timeframes?.length ? cfg.timeframes : ["M15", "H1"];
  const candlesByTf: Record<string, Awaited<ReturnType<typeof mt5.candles>>> = {};
  for (const tf of timeframes) candlesByTf[tf] = await mt5.candles(symbol, tf, 200);
  const analysis = buildMarketAnalysis(symbol, tick, candlesByTf);

  // 2. News gate
  const news = await assessNewsRisk(symbol, settings);

  // 3. Strategy signal
  const signal = evaluateStrategy(strategy, analysis);
  if (!signal.direction) {
    await audit({ actor: "system", userId: user.id, category: "strategy", action: "no_signal", detail: { symbol, reasons: signal.reasons } });
    return null;
  }
  const levels = deriveLevels(signal, analysis);
  if (!levels) return null;

  // 4. AI reasoning (advisory — can veto, can never force execution)
  const prompt = buildTradePrompt(
    analysis,
    news,
    `${signal.strategyName}: signal=${signal.direction}; reasons: ${signal.reasons.join("; ")}`,
    `maxRiskPerTrade=${settings.maxRiskPerTradePct}%, minRR=${settings.minRiskReward}, newsLimit=${settings.newsRiskLimit}`,
  );
  const { decision: ai, logId } = await askModel(prompt, symbol);

  const aiAgrees = ai.decision === signal.direction && ai.confidence >= signal.config.entry.minConfidence;
  if (!aiAgrees) {
    await audit({
      actor: "system", userId: user.id, category: "ai", action: "ai_veto",
      detail: { symbol, signal: signal.direction, ai: ai.decision, confidence: ai.confidence, reasoning: ai.reasoning },
    });
    if (ai.decision === "avoid") {
      await notify(user.id, "ai_avoid", `AI avoiding ${symbol}`, ai.reasoning.slice(0, 500));
    }
    return null;
  }

  // 5. Position sizing
  const account = await mt5.accountInfo();
  const lots =
    signal.config.lotSizing.method === "fixed"
      ? signal.config.lotSizing.fixedLots
      : calculateLots(account.balance, signal.config.lotSizing.riskPct, levels.entry, levels.stopLoss, settings.maxLotSize);

  const proposal: TradeProposal = {
    symbol,
    direction: signal.direction,
    lots,
    entry: levels.entry,
    stopLoss: ai.suggested_stop_loss ?? levels.stopLoss,
    takeProfit: ai.suggested_take_profit ?? levels.takeProfit,
  };

  // 6. Risk engine — final authority
  const riskCtx = await buildRiskContext(user, settings, account, analysis.spreadPoints, analysis.timeframes[0]?.atrPct ?? null, analysis.session, news.action);
  const risk = validateTrade(proposal, riskCtx);

  const explanation = {
    strategy: { name: signal.strategyName, reasons: signal.reasons },
    ai: { decision: ai.decision, confidence: ai.confidence, reasoning: ai.reasoning, risk_level: ai.risk_level },
    news: { level: news.level, action: news.action, reason: news.reason },
    risk: { ok: risk.ok, checks: risk.checks },
  };

  if (!risk.ok) {
    const failed = risk.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
    const trade = await prisma.trade.create({
      data: {
        userId: user.id, strategyId: strategy.id, symbol, direction: proposal.direction === "buy" ? "BUY" : "SELL",
        lots: proposal.lots, entryPrice: proposal.entry, stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit,
        status: "RISK_BLOCKED", mode: state.mode, aiAnalysisId: logId, explanation: explanation as object,
      },
    });
    await audit({ actor: "system", userId: user.id, category: "risk", action: "trade_blocked", detail: { tradeId: trade.id, failed } });
    await notify(user.id, "risk_violation", `Trade blocked: ${symbol}`, failed.join("\n"));
    return trade;
  }
  proposal.lots = risk.adjustedLots ?? proposal.lots;

  // 7. Mode gate
  if (state.mode === "MANUAL") {
    const trade = await prisma.trade.create({
      data: {
        userId: user.id, strategyId: strategy.id, symbol, direction: proposal.direction === "buy" ? "BUY" : "SELL",
        lots: proposal.lots, entryPrice: proposal.entry, stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit,
        status: "ANALYZED", mode: state.mode, aiAnalysisId: logId, explanation: explanation as object,
      },
    });
    await notify(user.id, "trade_opened", `Recommendation: ${proposal.direction.toUpperCase()} ${symbol}`,
      `${ai.reasoning.slice(0, 300)}\nEntry ~${proposal.entry} SL ${proposal.stopLoss} TP ${proposal.takeProfit}\n(Manual mode — no trade placed.)`);
    return trade;
  }

  if (state.mode === "SEMI_AUTO") {
    const trade = await prisma.trade.create({
      data: {
        userId: user.id, strategyId: strategy.id, symbol, direction: proposal.direction === "buy" ? "BUY" : "SELL",
        lots: proposal.lots, entryPrice: proposal.entry, stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit,
        status: "PENDING_APPROVAL", mode: state.mode, aiAnalysisId: logId, explanation: explanation as object,
        approval: { create: { expiresAt: new Date(Date.now() + APPROVAL_TTL_MIN * 60_000) } },
      },
      include: { approval: true },
    });
    await notify(user.id, "approval_request", `Approve trade? ${proposal.direction.toUpperCase()} ${symbol} ${proposal.lots} lots`,
      `${ai.reasoning.slice(0, 300)}\nEntry ~${proposal.entry} SL ${proposal.stopLoss} TP ${proposal.takeProfit}\nApprove with /approve_trade ${trade.id} or via dashboard. Expires in ${APPROVAL_TTL_MIN} min.`);
    broadcast("approval_request", { tradeId: trade.id, symbol, direction: proposal.direction, lots: proposal.lots });
    return trade;
  }

  // AUTO mode — execute immediately (all gates already passed).
  return executeTrade(user, proposal, { strategyId: strategy.id, aiLogId: logId, explanation, mode: state.mode, actor: "system:auto" });
}

export async function executeTrade(
  user: User,
  proposal: TradeProposal,
  opts: { strategyId?: string; aiLogId?: string; explanation: Record<string, unknown>; mode: "MANUAL" | "SEMI_AUTO" | "AUTO" | "COPY"; actor: string; existingTradeId?: string },
) {
  const result = await mt5.placeOrder(
    { symbol: proposal.symbol, direction: proposal.direction, volume: proposal.lots, sl: proposal.stopLoss ?? undefined, tp: proposal.takeProfit ?? undefined, comment: "mt5bot" },
    opts.actor,
  );

  const data = {
    status: result.ok ? ("EXECUTED" as const) : ("FAILED" as const),
    mt5Ticket: result.ticket ?? null,
    entryPrice: result.price ?? proposal.entry,
    openedAt: result.ok ? new Date() : null,
    lots: proposal.lots, // approver may have changed the size
    explanation: { ...opts.explanation, execution: { ok: result.ok, ticket: result.ticket, error: result.error } } as object,
  };

  const trade = opts.existingTradeId
    ? await prisma.trade.update({ where: { id: opts.existingTradeId }, data })
    : await prisma.trade.create({
        data: {
          userId: user.id, strategyId: opts.strategyId, symbol: proposal.symbol,
          direction: proposal.direction === "buy" ? "BUY" : "SELL",
          stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit, mode: opts.mode, aiAnalysisId: opts.aiLogId, ...data,
        },
      });

  await audit({ actor: opts.actor, userId: user.id, category: "trade", action: result.ok ? "trade_executed" : "trade_failed", detail: { tradeId: trade.id, result } });
  await notify(user.id, "trade_opened",
    result.ok ? `Trade opened: ${proposal.direction.toUpperCase()} ${proposal.symbol}` : `Trade FAILED: ${proposal.symbol}`,
    result.ok ? `${proposal.lots} lots @ ${data.entryPrice}, SL ${proposal.stopLoss}, TP ${proposal.takeProfit} (ticket ${result.ticket})` : `Broker error: ${result.error}`);
  broadcast("trade", { tradeId: trade.id, status: trade.status });
  return trade;
}

/**
 * Approve or reject a pending semi-auto trade. Re-runs the FULL risk check
 * at approval time — market conditions may have changed since the request.
 * `opts.lots` lets the approver choose the trade size; the risk engine
 * still has the final word on it.
 */
export async function decideTrade(
  tradeId: string,
  approve: boolean,
  decidedBy: string,
  channel: "DASHBOARD" | "TELEGRAM" | "WHATSAPP",
  opts: { lots?: number } = {},
) {
  const trade = await prisma.trade.findUnique({ where: { id: tradeId }, include: { approval: true, user: true } });
  if (!trade || trade.status !== "PENDING_APPROVAL" || !trade.approval) {
    return { ok: false, message: "Trade not found or not awaiting approval." };
  }
  if (trade.approval.expiresAt < new Date()) {
    await prisma.$transaction([
      prisma.tradeApproval.update({ where: { id: trade.approval.id }, data: { status: "expired" } }),
      prisma.trade.update({ where: { id: tradeId }, data: { status: "CANCELLED" } }),
    ]);
    return { ok: false, message: "Approval window expired; trade cancelled." };
  }

  await prisma.tradeApproval.update({
    where: { id: trade.approval.id },
    data: { status: approve ? "approved" : "rejected", decidedAt: new Date(), decidedBy, channel },
  });
  await audit({ actor: decidedBy, userId: trade.userId, category: "trade", action: approve ? "trade_approved" : "trade_rejected", detail: { tradeId, channel } });

  if (!approve) {
    await prisma.trade.update({ where: { id: tradeId }, data: { status: "REJECTED" } });
    return { ok: true, message: "Trade rejected." };
  }

  // Re-validate risk with fresh data before executing.
  const settings = await prisma.riskSettings.findUnique({ where: { userId: trade.userId } });
  const account = await mt5.accountInfo();
  const tick = await mt5.tick(trade.symbol);
  const news = settings ? await assessNewsRisk(trade.symbol, settings) : null;
  if (!settings || !news) return { ok: false, message: "Missing risk settings." };

  if (opts.lots !== undefined && !(opts.lots > 0 && Number.isFinite(opts.lots))) {
    return { ok: false, message: "Invalid lot size." };
  }
  const proposal: TradeProposal = {
    symbol: trade.symbol,
    direction: trade.direction === "BUY" ? "buy" : "sell",
    lots: opts.lots ?? trade.lots,
    entry: trade.direction === "BUY" ? tick.ask : tick.bid,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
  };
  const riskCtx = await buildRiskContext(trade.user, settings, account, tick.spread_points, null, sessionNow(), news.action);
  const risk = validateTrade(proposal, riskCtx);
  if (!risk.ok) {
    const failed = risk.checks.filter((c) => !c.passed).map((c) => c.name).join(", ");
    await prisma.trade.update({ where: { id: tradeId }, data: { status: "RISK_BLOCKED" } });
    return { ok: false, message: `Approved, but risk re-check failed (${failed}). Trade blocked.` };
  }
  proposal.lots = risk.adjustedLots ?? proposal.lots;

  const explanation = (trade.explanation ?? {}) as Record<string, unknown>;
  await executeTrade(trade.user, proposal, {
    strategyId: trade.strategyId ?? undefined, aiLogId: trade.aiAnalysisId ?? undefined,
    explanation: { ...explanation, approval: { decidedBy, channel, chosenLots: proposal.lots } }, mode: trade.mode, actor: decidedBy, existingTradeId: trade.id,
  });
  return { ok: true, message: `Trade approved and executed (${proposal.lots} lots).` };
}

export async function buildRiskContext(
  user: User,
  settings: NonNullable<Awaited<ReturnType<typeof prisma.riskSettings.findUnique>>>,
  account: Awaited<ReturnType<typeof mt5.accountInfo>>,
  spreadPoints: number,
  atrPct: number | null,
  session: string,
  newsAction: "allow" | "reduce" | "pause",
  opts: { twoFactorVerified?: boolean; isCopy?: boolean } = {},
): Promise<RiskContext> {
  const state = await getBotState();
  const positions = await mt5.positions();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());

  const [tradesToday, copiedToday, dailyAgg, weeklyAgg, peak, closedToday] = await Promise.all([
    prisma.trade.count({ where: { userId: user.id, status: "EXECUTED", createdAt: { gte: dayStart } } }),
    prisma.trade.count({ where: { userId: user.id, mode: "COPY", status: "EXECUTED", createdAt: { gte: dayStart } } }),
    prisma.trade.aggregate({ _sum: { profit: true }, where: { userId: user.id, closedAt: { gte: dayStart } } }),
    prisma.trade.aggregate({ _sum: { profit: true }, where: { userId: user.id, closedAt: { gte: weekStart } } }),
    prisma.systemSetting.findUnique({ where: { key: "peak_equity" } }),
    prisma.trade.findMany({
      where: { userId: user.id, status: "CLOSED", closedAt: { gte: dayStart } },
      orderBy: { closedAt: "desc" },
      select: { profit: true },
      take: 20,
    }),
  ]);

  let consecutiveLosses = 0;
  for (const t of closedToday) {
    if ((t.profit ?? 0) < 0) consecutiveLosses++;
    else break;
  }

  const peakEquity = Math.max(Number((peak?.value as { value?: number })?.value ?? 0), account.equity);
  await prisma.systemSetting.upsert({
    where: { key: "peak_equity" },
    create: { key: "peak_equity", value: { value: peakEquity } },
    update: { value: { value: peakEquity } },
  });

  const verifiedAccount = await prisma.mt5Account.findFirst({ where: { userId: user.id, verified: true } });

  return {
    settings,
    account: { balance: account.balance, equity: account.equity, margin_level: account.margin_level },
    openPositions: positions.map((p) => ({ symbol: p.symbol, volume: p.volume, profit: p.profit })),
    tradesToday,
    copiedTradesToday: copiedToday,
    consecutiveLosses,
    dailyPnl: dailyAgg._sum.profit ?? 0,
    weeklyPnl: weeklyAgg._sum.profit ?? 0,
    peakEquity,
    spreadPoints,
    atrPct,
    session,
    newsAction,
    emergencyStop: state.emergencyStop,
    botRunning: state.status === "running",
    isLiveAccount: !account.is_demo,
    liveTradingEnabled: state.liveTradingEnabled,
    userLiveEnabled: user.liveTradingEnabled,
    twoFactorVerified: opts.twoFactorVerified ?? false,
    accountVerified: !!verifiedAccount || account.is_demo,
  };
}

export function sessionNow(): string {
  const h = new Date().getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  if (h >= 7 && h < 12) return "london";
  if (h >= 12 && h < 16) return "london_newyork_overlap";
  if (h >= 16 && h < 21) return "newyork";
  return "sydney";
}

/** Emergency stop: halt the bot AND flatten all open positions. */
export async function emergencyStopAll(actor: string, userId: string) {
  const { setBotState } = await import("../system/state.js");
  await setBotState({ emergencyStop: true, status: "emergency_stop" }, actor);
  const positions = await mt5.positions();
  const closed: string[] = [];
  for (const p of positions) {
    const r = await mt5.closePosition(p.ticket, actor);
    if (r.ok) closed.push(p.ticket);
  }
  await audit({ actor, userId, category: "system", action: "emergency_stop", detail: { closedTickets: closed } });
  await notify(userId, "emergency_stop", "EMERGENCY STOP ACTIVATED", `All trading halted. Closed ${closed.length} position(s).`);
  broadcast("emergency_stop", { closed });
  return closed;
}
