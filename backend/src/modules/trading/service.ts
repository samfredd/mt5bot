import { prisma } from "../../lib/prisma.js";
import { audit, logError } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { buildMarketAnalysis, detectSession } from "../analysis/engine.js";
import { assessNewsRisk } from "../news/service.js";
import { evaluateStrategy, deriveLevels } from "../strategy/service.js";
import { askModel, getActiveProvider, PURE_LOGIC_PROVIDER, pureLogicDecision } from "../ai/service.js";
import { buildTradePrompt } from "../ai/prompts.js";
import { clampSuggestedLevels } from "../ai/schema.js";
import { buildDecisionContext } from "../analysis/context.js";
import { cachedSentiment, refreshSentimentSoon } from "../sentiment/service.js";
import { calculateLots, countConsecutiveLosses, equityGuardianBreaches, validateTrade, type RiskContext, type TradeProposal } from "../risk/engine.js";
import { accountIdForLogin, currentAccountId } from "../mt5/account.js";
import { getBotState, operationalTradingAvailable, setBotState } from "../system/state.js";
import { getOperationalConfig } from "../system/operational-config.js";
import { fitLotsToExposure } from "../risk/exposure.js";
import { adaptiveRiskSettings, applyAiLotSizing } from "../risk/adaptive.js";
import { isNewCompletedBar, normalizeCandles } from "../backtest/market-data.js";
import { notify } from "../notifications/service.js";
import { broadcast } from "../ws/hub.js";
import type { Strategy, User } from "@prisma/client";
import { fallbackTradingSpec, moneyForPriceMove } from "../risk/instruments.js";
import { reportIncident } from "../incidents/service.js";
import { openPaperTrade } from "./paper.js";
import { recordEntryComparison } from "./execution-comparison.js";
import { symbolHeldByOther } from "./symbol-lock.js";
import { applyOrderResult, markIntentSubmitting, markIntentUnknown, prepareDurableExecution } from "./execution-intent.js";

const EMERGENCY_FLATTEN_KEY = "emergency_flatten_job";

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
  if (!(await operationalTradingAvailable())) {
    await reportIncident({
      dedupeKey: "redis:trading-unavailable",
      severity: "CRITICAL",
      source: "redis",
      title: "Trading blocked: Redis unavailable",
      message: "New-trade evaluation is fail-closed until operational state coordination recovers.",
      context: { strategyId: strategy.id, symbol },
      minIntervalMs: 60_000,
    });
    return null;
  }

  const settings = await prisma.riskSettings.findUnique({ where: { userId: user.id } });
  if (!settings) {
    await audit({ actor: "system", userId: user.id, category: "risk", action: "missing_risk_settings", detail: { symbol } });
    return null;
  }

  // 0. Cross-strategy guard: one position per pair. If another strategy (or a
  // manual/scanner trade) already holds this market, stand aside before
  // spending a candle fetch + AI call — prevents stacking/offsetting.
  //
  // Scope the guard to the account the terminal is on NOW: a trade left
  // EXECUTED on a previous account must NOT block this one (reconciliation can
  // never close it, so it would zombie-block the pair forever). One cheap
  // bridge call up front; the candle+AI cost is still gated behind the guard.
  const terminalAccountId = await currentAccountId(user.id);
  const heldBy = await symbolHeldByOther(user.id, symbol, strategy.id, terminalAccountId);
  if (heldBy) {
    await audit({
      actor: "system", userId: user.id, category: "strategy", action: "symbol_occupied",
      detail: { symbol, strategy: strategy.name, heldByTradeId: heldBy.id, heldBySymbol: heldBy.symbol, heldByStrategyId: heldBy.strategyId },
    });
    return null;
  }

  // 1. Market data + technical analysis
  const tick = await mt5.tick(symbol);
  const cfg = strategy.config as { timeframes?: string[] };
  const timeframes = cfg.timeframes?.length ? cfg.timeframes : ["M15", "H1"];
  const candlesByTf: Record<string, Awaited<ReturnType<typeof mt5.candles>>> = {};
  const tickTime = Date.parse(tick.time);
  for (const tf of timeframes) {
    candlesByTf[tf] = normalizeCandles(await mt5.candles(symbol, tf, 201), tf, tickTime).slice(-200);
  }
  const completedPrimary = candlesByTf[timeframes[0]]?.at(-1);
  if (!completedPrimary) return null;
  const checkpointKey = `strategy-bar:${strategy.id}:${symbol.toUpperCase()}`;
  const checkpoint = await prisma.systemSetting.findUnique({ where: { key: checkpointKey } });
  const lastProcessed = (checkpoint?.value as { time?: string } | null)?.time ?? null;
  if (!isNewCompletedBar(completedPrimary.time, lastProcessed)) return null;
  const analysis = buildMarketAnalysis(symbol, tick, candlesByTf);

  // 2. News gate
  const news = await assessNewsRisk(symbol, settings);

  // 3. Strategy signal
  const signal = evaluateStrategy(strategy, analysis);
  await prisma.systemSetting.upsert({
    where: { key: checkpointKey },
    create: { key: checkpointKey, value: { time: completedPrimary.time } },
    update: { value: { time: completedPrimary.time } },
  });
  if (!signal.direction) {
    await audit({ actor: "system", userId: user.id, category: "strategy", action: "no_signal", detail: { symbol, reasons: signal.reasons } });
    return null;
  }
  const levels = deriveLevels(signal, analysis);
  if (!levels) return null;

  // 4. AI reasoning (advisory — can veto, can never force execution).
  // The model gets a pre-computed decision context, never raw indicator dumps:
  // account + preview sizing are gathered first so the payload's risk block is
  // real, and sentiment is a cache-only read (a refresh is kicked off for the
  // NEXT evaluation, so the trade path never waits on web search).
  const account = await mt5.accountInfo();
  const capital = adaptiveRiskSettings(settings, account.equity, state.adaptiveRiskEnabled);
  const effectiveSettings = capital.settings;
  const accountId = await accountIdForLogin(user.id, account.login, account);
  const instrumentSpec = await mt5.symbolInfo(symbol).catch(() => fallbackTradingSpec(symbol, levels.entry));
  const openPositions = await mt5.positions().catch(() => []);
  const previewLots =
    signal.config.lotSizing.method === "fixed"
      ? Math.min(signal.config.lotSizing.fixedLots, calculateLots(symbol, account.balance, effectiveSettings.maxRiskPerTradePct, levels.entry, levels.stopLoss, effectiveSettings.maxLotSize, instrumentSpec))
      : calculateLots(symbol, account.balance, Math.min(signal.config.lotSizing.riskPct, effectiveSettings.maxRiskPerTradePct), levels.entry, levels.stopLoss, effectiveSettings.maxLotSize, instrumentSpec);
  const sentiment = await cachedSentiment(symbol).catch(() => null);
  refreshSentimentSoon(symbol);

  const context = buildDecisionContext({
    symbol,
    session: analysis.session,
    quote: { bid: analysis.bid, ask: analysis.ask, spreadPoints: analysis.spreadPoints },
    candlesByTf,
    news,
    sentiment,
    setup: {
      source: `strategy:${signal.strategyName}`,
      direction: signal.direction,
      signalReasons: signal.reasons,
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
      suggestedLots: previewLots,
      moneyAtRisk: Math.abs(moneyForPriceMove(Math.abs(levels.entry - levels.stopLoss), previewLots, instrumentSpec)),
      riskPctOfBalance: signal.config.lotSizing.method === "fixed" ? null : signal.config.lotSizing.riskPct,
    },
    account: { balance: account.balance, equity: account.equity, currency: account.currency, openPositions: openPositions.length },
    limits: {
      min_rr: settings.minRiskReward,
      max_risk_per_trade_pct: effectiveSettings.maxRiskPerTradePct,
      max_spread_points: effectiveSettings.maxSpreadPoints,
      max_open_trades: effectiveSettings.maxOpenTrades,
    },
  });
  const aiMode = await getActiveProvider();
  const pureLogic = aiMode === PURE_LOGIC_PROVIDER;
  const aiResult = pureLogic ? null : await askModel(buildTradePrompt(context), symbol, {
    userId: user.id,
    strategyId: strategy.id,
    direction: signal.direction,
    source: "strategy",
  });
  const ai = pureLogic ? pureLogicDecision(signal.direction) : aiResult!.decision;
  const judgment = pureLogic ? null : aiResult!.judgment;
  const logId = pureLogic ? null : aiResult!.logId;
  const aiValid = pureLogic || aiResult!.valid;

  // AI unreachable/invalid is NOT the same as a real "avoid" — record it
  // distinctly so a down model shows up in the activity log instead of
  // looking like the AI simply disagreed.
  if (!aiValid) {
    await audit({ actor: "system", userId: user.id, category: "ai", action: "ai_unavailable", detail: { symbol, signal: signal.direction } });
    return null;
  }

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

  // 5. Final levels + position sizing. The model may refine SL/TP, but only
  // within a sane ATR band on the correct side of entry (clampSuggestedLevels)
  // — a hallucinated level can never replace the engineered one. Lots are
  // sized from the stop that will actually be sent to the broker.
  const clamped = clampSuggestedLevels(
    signal.direction,
    levels.entry,
    analysis.timeframes[0]?.atr ?? null,
    ai.suggested_stop_loss,
    ai.suggested_take_profit,
  );
  const stopLoss = clamped.stopLoss ?? levels.stopLoss;
  const takeProfit = clamped.takeProfit ?? levels.takeProfit;
  const baseLots =
    signal.config.lotSizing.method === "fixed"
      ? Math.min(signal.config.lotSizing.fixedLots, calculateLots(symbol, account.balance, effectiveSettings.maxRiskPerTradePct, levels.entry, stopLoss, effectiveSettings.maxLotSize, instrumentSpec))
      : calculateLots(symbol, account.balance, Math.min(signal.config.lotSizing.riskPct, effectiveSettings.maxRiskPerTradePct), levels.entry, stopLoss, effectiveSettings.maxLotSize, instrumentSpec);
  const aiSizing = applyAiLotSizing({
    baseLots,
    direction: signal.direction,
    decision: ai,
    judgment,
    instrument: instrumentSpec,
    enabled: state.adaptiveRiskEnabled,
    pureLogic,
  });

  const proposal: TradeProposal = {
    symbol,
    direction: signal.direction,
    lots: aiSizing.lots,
    entry: levels.entry,
    stopLoss,
    takeProfit,
    instrumentSpec,
  };

  // 6. Risk engine — final authority
  const riskCtx = await buildRiskContext(
    user,
    settings,
    account,
    analysis.spreadPoints,
    analysis.timeframes[0]?.atrPct ?? null,
    analysis.session,
    news.action,
    { proposal },
  );
  const risk = validateTrade(proposal, riskCtx);

  const explanation = {
    strategy: { name: signal.strategyName, reasons: signal.reasons },
    ai: {
      mode: aiMode,
      skipped: pureLogic,
      decision: ai.decision, confidence: ai.confidence, reasoning: ai.reasoning, risk_level: ai.risk_level,
      ...(judgment
        ? {
            finalVerdict: judgment.final_verdict,
            reasonsAgainst: judgment.reasons_against_trade,
            invalidators: judgment.trade_invalidators,
            requiredConfirmations: judgment.required_confirmations,
            expectedHoldingTime: judgment.expected_holding_time,
            marketRegime: judgment.market_regime,
          }
        : {}),
    },
    context: {
      marketRegime: context.market_regime,
      confidenceEngine: context.confidence_engine,
      missingData: context.missing_data,
    },
    capitalSizing: { profile: capital.profile, ai: aiSizing },
    news: { level: news.level, action: news.action, reason: news.reason },
    risk: { ok: risk.ok, checks: risk.checks },
  };

  if (!risk.ok) {
    const failed = risk.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
    const trade = await prisma.trade.create({
      data: {
        userId: user.id, accountId, strategyId: strategy.id, symbol, direction: proposal.direction === "buy" ? "BUY" : "SELL",
        lots: proposal.lots, entryPrice: proposal.entry, stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit,
        status: "RISK_BLOCKED", mode: state.mode, aiAnalysisId: logId, explanation: explanation as object,
      },
    });
    await audit({ actor: "system", userId: user.id, category: "risk", action: "trade_blocked", detail: { tradeId: trade.id, failed } });
    await notify(user.id, "risk_violation", `Trade blocked: ${symbol}`, failed.join("\n"));
    return trade;
  }
  proposal.lots = risk.adjustedLots ?? proposal.lots;

  if (state.paperForward) {
    const operational = await getOperationalConfig();
    const paperTrade = await openPaperTrade({
      userId: user.id,
      strategyId: strategy.id,
      proposal,
      tick,
      expectedSlippagePoints: operational.paperExpectedSlippagePoints,
      commissionPerLot: operational.paperCommissionPerLot,
      explanation,
    });
    await audit({
      actor: "system:paper-forward",
      userId: user.id,
      category: "trade",
      action: "paper_trade_opened",
      detail: { paperTradeId: paperTrade.id, symbol, direction: proposal.direction, lots: proposal.lots },
    });
    await notify(
      user.id,
      "trade_opened",
      `Paper trade opened: ${proposal.direction.toUpperCase()} ${symbol}`,
      `${proposal.lots} lots, SL ${proposal.stopLoss}, TP ${proposal.takeProfit}. No broker order was sent.`,
    );
    broadcast("paper_trade", { paperTradeId: paperTrade.id, status: paperTrade.status });
    return paperTrade;
  }

  // 7. Mode gate
  if (state.mode === "MANUAL") {
    const trade = await prisma.trade.create({
      data: {
        userId: user.id, accountId, strategyId: strategy.id, symbol, direction: proposal.direction === "buy" ? "BUY" : "SELL",
        lots: proposal.lots, entryPrice: proposal.entry, stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit,
        status: "ANALYZED", mode: state.mode, aiAnalysisId: logId, explanation: explanation as object,
      },
    });
    await notify(user.id, "trade_opened", `Recommendation: ${proposal.direction.toUpperCase()} ${symbol}`,
      `${ai.reasoning.slice(0, 300)}\nEntry ~${proposal.entry} SL ${proposal.stopLoss} TP ${proposal.takeProfit}\n(Manual mode — no trade placed.)`);
    return trade;
  }

  if (state.mode === "SEMI_AUTO") {
    const { tradeApprovalTtlMin } = await getOperationalConfig();
    const trade = await prisma.trade.create({
      data: {
        userId: user.id, accountId, strategyId: strategy.id, symbol, direction: proposal.direction === "buy" ? "BUY" : "SELL",
        lots: proposal.lots, entryPrice: proposal.entry, stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit,
        status: "PENDING_APPROVAL", mode: state.mode, aiAnalysisId: logId, explanation: explanation as object,
        approval: { create: { expiresAt: new Date(Date.now() + tradeApprovalTtlMin * 60_000) } },
      },
      include: { approval: true },
    });
    await notify(user.id, "approval_request", `Approve trade? ${proposal.direction.toUpperCase()} ${symbol} ${proposal.lots} lots`,
      `${ai.reasoning.slice(0, 300)}\nEntry ~${proposal.entry} SL ${proposal.stopLoss} TP ${proposal.takeProfit}\nApprove with /approve_trade ${trade.id} or via dashboard. Expires in ${tradeApprovalTtlMin} min.`);
    broadcast("approval_request", { tradeId: trade.id, symbol, direction: proposal.direction, lots: proposal.lots });
    return trade;
  }

  // AUTO mode — execute immediately (all gates already passed).
  return executeTrade(user, proposal, {
    strategyId: strategy.id,
    aiLogId: logId ?? undefined,
    explanation,
    mode: state.mode,
    actor: "system:auto",
    expectedSpreadPoints: analysis.spreadPoints,
    actualSpreadPoints: tick.spread_points,
  });
}

export async function executeTrade(
  user: User,
  proposal: TradeProposal,
  opts: {
    strategyId?: string; aiLogId?: string; explanation: Record<string, unknown>;
    mode: "MANUAL" | "SEMI_AUTO" | "AUTO" | "COPY"; actor: string; existingTradeId?: string;
    durationMin?: number;
    expectedSpreadPoints?: number;
    actualSpreadPoints?: number;
    maxEntriesPerMarket?: number;
  },
) {
  if (!(await operationalTradingAvailable())) {
    await reportIncident({
      dedupeKey: "redis:trading-unavailable",
      severity: "CRITICAL",
      source: "redis",
      title: "Trade execution blocked: Redis unavailable",
      message: "The broker order was not sent because operational coordination is unavailable.",
      context: { symbol: proposal.symbol, actor: opts.actor },
      minIntervalMs: 60_000,
    });
    throw new Error("operational trading unavailable");
  }
  const requestedAt = new Date();
  let prepared;
  try {
    prepared = await prepareDurableExecution({ user, proposal, mode: opts.mode, strategyId: opts.strategyId, aiLogId: opts.aiLogId, explanation: opts.explanation, existingTradeId: opts.existingTradeId, durationMin: opts.durationMin, maxEntriesPerMarket: opts.maxEntriesPerMarket });
  } catch (error) {
    if (opts.existingTradeId) {
      await prisma.trade.update({ where: { id: opts.existingTradeId }, data: {
        status: "FAILED",
        explanation: { ...opts.explanation, executionPreparationError: String(error) } as object,
      } });
    }
    throw error;
  }
  await markIntentSubmitting(prepared.intent.id);
  let result;
  try {
    result = await mt5.placeOrder(prepared.request, opts.actor);
  } catch (error) {
    await markIntentUnknown(prepared.intent.id, prepared.trade.id, error);
    await reportIncident({ dedupeKey: `execution:unknown:${prepared.intent.clientOrderId}`, severity: "CRITICAL", source: "execution", title: `Unknown broker outcome: ${proposal.symbol}`, message: "The broker request outcome is unknown. Automatic retry is blocked until reconciliation resolves the client order ID.", context: { tradeId: prepared.trade.id, clientOrderId: prepared.intent.clientOrderId, error: String(error) } });
    throw error;
  }
  const filledAt = new Date();
  const applied = await applyOrderResult(prepared.intent.id, prepared.trade.id, result);
  const trade = await prisma.trade.update({ where: { id: applied.trade.id }, data: { explanation: { ...opts.explanation, execution: { clientOrderId: prepared.intent.clientOrderId, status: result.status, ok: result.ok, ticket: result.ticket, positionId: result.position_id, retcode: result.retcode, error: result.error } } as object } });

  if (result.ok && result.price !== undefined) {
    const instrument = proposal.instrumentSpec ?? fallbackTradingSpec(proposal.symbol, proposal.entry);
    const expectedExit = proposal.takeProfit ?? null;
    const expectedMove = expectedExit === null
      ? null
      : proposal.direction === "buy" ? expectedExit - proposal.entry : proposal.entry - expectedExit;
    const expectedPnl = expectedMove === null
      ? null
      : Number((moneyForPriceMove(expectedMove, proposal.lots, instrument) - 7 * proposal.lots).toFixed(2));
    await recordEntryComparison({
      tradeId: trade.id,
      userId: user.id,
      direction: proposal.direction === "buy" ? "BUY" : "SELL",
      expectedEntry: proposal.entry,
      actualEntry: result.price,
      expectedExit,
      expectedPnl,
      expectedSpreadPoints: opts.expectedSpreadPoints,
      actualSpreadPoints: opts.actualSpreadPoints,
      expectedSlippagePoints: 2,
      requestedAt,
      filledAt,
    }).catch((error) => logError("execution-comparison", "failed to record broker entry comparison", {
      tradeId: trade.id,
      error: String(error),
    }));
  }

  await audit({ actor: opts.actor, userId: user.id, category: "trade", action: result.ok ? "trade_executed" : "trade_failed", detail: { tradeId: trade.id, result } });
  await notify(user.id, "trade_opened",
    result.ok ? `Trade opened: ${proposal.direction.toUpperCase()} ${proposal.symbol}` : `Trade ${result.status === "PLACED" || result.status === "UNKNOWN" ? "pending broker confirmation" : "FAILED"}: ${proposal.symbol}`,
    result.ok ? `${trade.lots} lots @ ${trade.entryPrice}, SL ${proposal.stopLoss}, TP ${proposal.takeProfit} (ticket ${result.ticket})` : `Broker status: ${result.status ?? "REJECTED"}; ${result.error ?? "awaiting reconciliation"}`);
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
  opts: { actorUserId: string; lots?: number; durationMin?: number; twoFactorVerified?: boolean },
) {
  if (opts.lots !== undefined && !(opts.lots > 0 && Number.isFinite(opts.lots))) {
    return { ok: false, message: "Invalid lot size." };
  }
  const trade = await prisma.trade.findUnique({ where: { id: tradeId }, include: { approval: true, user: true } });
  if (!trade || trade.userId !== opts.actorUserId || trade.status !== "PENDING_APPROVAL" || !trade.approval) {
    return { ok: false, message: "Trade not found or not awaiting approval." };
  }
  if (trade.approval.expiresAt < new Date()) {
    const cancelled = await prisma.trade.updateMany({
      where: { id: tradeId, status: "PENDING_APPROVAL" },
      data: { status: "CANCELLED" },
    });
    if (cancelled.count !== 1) {
      return { ok: false, message: "Trade was already decided by another request." };
    }
    await prisma.tradeApproval.update({ where: { id: trade.approval.id }, data: { status: "expired" } });
    return { ok: false, message: "Approval window expired; trade cancelled." };
  }

  // Claim the trade with one conditional database update before any broker I/O.
  // Concurrent dashboard/chat retries can all read the same pending row, but
  // exactly one request can transition it and therefore submit an order.
  const claimed = await prisma.trade.updateMany({
    where: { id: tradeId, status: "PENDING_APPROVAL" },
    data: { status: approve ? "APPROVED" : "REJECTED" },
  });
  if (claimed.count !== 1) {
    return { ok: false, message: "Trade was already decided by another request." };
  }
  await prisma.tradeApproval.update({
    where: { id: trade.approval.id },
    data: { status: approve ? "approved" : "rejected", decidedAt: new Date(), decidedBy, channel },
  });
  await audit({ actor: decidedBy, userId: trade.userId, category: "trade", action: approve ? "trade_approved" : "trade_rejected", detail: { tradeId, channel } });

  if (!approve) {
    return { ok: true, message: "Trade rejected." };
  }

  // Re-validate risk with fresh data before executing.
  const settings = await prisma.riskSettings.findUnique({ where: { userId: trade.userId } });
  const account = await mt5.accountInfo();
  const tick = await mt5.tick(trade.symbol);
  const news = settings ? await assessNewsRisk(trade.symbol, settings) : null;
  if (!settings || !news) {
    await prisma.trade.update({ where: { id: tradeId }, data: { status: "RISK_BLOCKED" } });
    return { ok: false, message: "Missing risk settings." };
  }
  const proposal: TradeProposal = {
    symbol: trade.symbol,
    direction: trade.direction === "BUY" ? "buy" : "sell",
    lots: opts.lots ?? trade.lots,
    entry: trade.direction === "BUY" ? tick.ask : tick.bid,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
  };
  const riskCtx = await buildRiskContext(trade.user, settings, account, tick.spread_points, null, sessionNow(), news.action, {
    proposal,
    twoFactorVerified: opts.twoFactorVerified,
  });
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
    explanation: { ...explanation, approval: { decidedBy, channel, chosenLots: proposal.lots, durationMin: opts.durationMin } },
    mode: trade.mode,
    actor: decidedBy,
    existingTradeId: trade.id,
    durationMin: opts.durationMin,
    expectedSpreadPoints: tick.spread_points,
    actualSpreadPoints: tick.spread_points,
  });
  return { ok: true, message: `Trade approved and executed (${proposal.lots} lots${opts.durationMin ? `, auto-closes after ${opts.durationMin} min` : ""}).` };
}

export async function buildRiskContext(
  user: User,
  settings: NonNullable<Awaited<ReturnType<typeof prisma.riskSettings.findUnique>>>,
  account: Awaited<ReturnType<typeof mt5.accountInfo>>,
  spreadPoints: number,
  atrPct: number | null,
  session: string,
  newsAction: "allow" | "reduce" | "pause",
  opts: { twoFactorVerified?: boolean; isCopy?: boolean; proposal?: TradeProposal } = {},
): Promise<RiskContext> {
  const state = await getBotState();
  const capital = adaptiveRiskSettings(settings, account.equity, state.adaptiveRiskEnabled);
  const effectiveSettings = capital.settings;
  const positions = await mt5.positions();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());

  // Daily/weekly loss limits and the loss-streak breaker are per account —
  // losses on a previous account must not block trading on this one.
  const accountId = await accountIdForLogin(user.id, account.login, account);
  const scope = accountId ? { userId: user.id, accountId } : { userId: user.id };
  const savedAccount = !account.is_demo && accountId
    ? await prisma.mt5Account.findFirst({ where: { id: accountId, userId: user.id }, select: { verified: true } })
    : null;

  const [tradesToday, copiedToday, dailyAgg, weeklyAgg, peak, closedToday] = await Promise.all([
    // Closed trades still consumed a daily slot. Counting only rows whose
    // current status is EXECUTED would let a fast-closing strategy recycle the
    // same slot indefinitely and defeat both caps.
    prisma.trade.count({ where: { ...scope, status: { in: ["EXECUTED", "CLOSED"] }, openedAt: { gte: dayStart } } }),
    prisma.trade.count({ where: { ...scope, mode: "COPY", status: { in: ["EXECUTED", "CLOSED"] }, openedAt: { gte: dayStart } } }),
    prisma.trade.aggregate({ _sum: { profit: true }, where: { ...scope, closedAt: { gte: dayStart } } }),
    prisma.trade.aggregate({ _sum: { profit: true }, where: { ...scope, closedAt: { gte: weekStart } } }),
    // Peak equity (drawdown reference) is tracked per account for the same reason.
    prisma.systemSetting.findUnique({ where: { key: accountId ? `peak_equity:${accountId}` : "peak_equity" } }),
    prisma.trade.findMany({
      where: { ...scope, status: "CLOSED", closedAt: { gte: dayStart } },
      orderBy: { closedAt: "desc" },
      select: { profit: true },
      take: 20,
    }),
  ]);

  const consecutiveLosses = countConsecutiveLosses(closedToday);

  const peakEquity = Math.max(Number((peak?.value as { value?: number })?.value ?? 0), account.equity);
  const peakKey = accountId ? `peak_equity:${accountId}` : "peak_equity";
  await prisma.systemSetting.upsert({
    where: { key: peakKey },
    create: { key: peakKey, value: { value: peakEquity } },
    update: { value: { value: peakEquity } },
  });

  const proposalSpec = opts.proposal
    ? opts.proposal.instrumentSpec ?? fallbackTradingSpec(opts.proposal.symbol, opts.proposal.entry)
    : null;
  const exposureGate = opts.proposal && proposalSpec ? fitLotsToExposure({
    positions: positions.map((position) => ({
      symbol: position.symbol,
      direction: position.type,
      lots: position.volume,
      price: position.price_current ?? position.price_open,
    })),
    proposal: {
      symbol: opts.proposal.symbol,
      direction: opts.proposal.direction,
      lots: opts.proposal.lots,
      price: opts.proposal.entry,
    },
    accountEquity: account.equity,
    maxCurrencyExposurePct: effectiveSettings.maxCurrencyExposurePct,
    maxCorrelatedExposurePct: effectiveSettings.maxCorrelatedExposurePct,
    volumeMin: proposalSpec.volumeMin,
    volumeStep: proposalSpec.volumeStep,
  }) : undefined;

  return {
    settings: effectiveSettings,
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
    // The 2FA gate is satisfied when: the caller verified a TOTP (manual path),
    // OR live 2FA is switched off, OR — for the automated path that can't enter
    // a code — the operator granted standing auto-live authorization.
    twoFactorVerified: opts.twoFactorVerified ?? (!state.requireLiveTwoFactor || state.autoLiveAuthorized),
    strategyValidationApproved: (await getOperationalConfig()).strategyValidationApproved,
    liveAccountVerified: account.is_demo || savedAccount?.verified === true,
    exposureGate,
  };
}

export function sessionNow(): string {
  return detectSession();
}

/** Emergency stop: halt the bot AND flatten all open positions. */
export async function emergencyStopAll(actor: string, userId: string) {
  await setBotState({ emergencyStop: true, status: "emergency_stop" }, actor);
  await prisma.systemSetting.upsert({
    where: { key: EMERGENCY_FLATTEN_KEY },
    create: { key: EMERGENCY_FLATTEN_KEY, value: { status: "pending", actor, userId, attempts: 0, createdAt: new Date().toISOString() } },
    update: { value: { status: "pending", actor, userId, attempts: 0, createdAt: new Date().toISOString() } },
  });
  const closed = await retryEmergencyFlatten();
  await audit({ actor, userId, category: "system", action: "emergency_stop", detail: { closedTickets: closed } });
  await notify(userId, "emergency_stop", "EMERGENCY STOP ACTIVATED", `All trading halted. Closed ${closed.length} position(s); any residual positions will be retried automatically.`);
  broadcast("emergency_stop", { closed });
  return closed;
}

/** Durable, idempotent emergency flatten retry. Emergency stop is explicitly
 * account-wide; unlike normal management it intentionally includes manual and
 * other-EA positions. */
export async function retryEmergencyFlatten(): Promise<string[]> {
  const row = await prisma.systemSetting.findUnique({ where: { key: EMERGENCY_FLATTEN_KEY } });
  const job = row?.value as { status?: string; actor?: string; userId?: string; attempts?: number; createdAt?: string } | undefined;
  if (!job || job.status !== "pending") return [];
  const positions = await mt5.positions().catch(() => []);
  const closed: string[] = [];
  for (const p of positions) {
    const r = await mt5.closePosition(p.ticket, job.actor ?? "system:emergency-retry").catch(() => ({ ok: false as const }));
    if (r.ok) closed.push(p.ticket);
  }
  const remaining = await mt5.positions().catch(() => positions.filter((position) => !closed.includes(position.ticket)));
  const next = { ...job, status: remaining.length ? "pending" : "complete", attempts: (job.attempts ?? 0) + 1, lastAttemptAt: new Date().toISOString(), remainingTickets: remaining.map((position) => position.ticket) };
  await prisma.systemSetting.update({ where: { key: EMERGENCY_FLATTEN_KEY }, data: { value: next } });
  if (remaining.length) {
    await reportIncident({
      dedupeKey: "emergency-flatten:residual",
      severity: "CRITICAL",
      source: "execution",
      title: "Emergency flatten has residual positions",
      message: `${remaining.length} position(s) remain open and will be retried by the protection worker.`,
      context: { tickets: remaining.map((position) => position.ticket), attempts: next.attempts },
      minIntervalMs: 60_000,
    });
  }
  return closed;
}

/**
 * Equity guardian: when equity falls through the protection floor, close all
 * open positions and PAUSE (recoverable — not a hard emergency stop). The
 * risk engine only BLOCKS new trades at this threshold; this actually stops
 * the bleeding on positions already open.
 *
 * Runs only while the bot is "running", which makes it self-limiting: once it
 * pauses, it won't fire again until the operator resumes (so it can't thrash,
 * and after a flatten — equity ≈ balance — it wouldn't re-trip anyway).
 */
export async function enforceEquityGuardian(): Promise<void> {
  const state = await getBotState();
  if (state.status !== "running" || state.emergencyStop) return;

  const user = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  const settings = user && (await prisma.riskSettings.findUnique({ where: { userId: user.id } }));
  if (!user || !settings) return;

  const account = await mt5.accountInfo().catch(() => null);
  if (!account) return;
  const positions = await mt5.positions().catch(() => []);
  if (!positions.length) return; // nothing to protect

  const breaches = equityGuardianBreaches(account, settings);
  if (!breaches.length) return;

  const closed: string[] = [];
  for (const p of positions) {
    const r = await mt5.closePosition(p.ticket, "system:equity-guardian").catch(() => ({ ok: false as const }));
    if (r.ok) closed.push(p.ticket);
  }
  await setBotState({ status: "paused" }, "system:equity-guardian");
  await audit({
    actor: "system:equity-guardian", userId: user.id, category: "risk", action: "equity_guardian_flatten",
    detail: { breaches, balance: account.balance, equity: account.equity, closed },
  });
  await reportIncident({
    dedupeKey: "risk:equity-guardian",
    severity: "CRITICAL",
    source: "risk",
    title: "Equity guardian activated",
    message: `${breaches.join("; ")}. Positions were flattened and the bot was paused.`,
    context: { balance: account.balance, equity: account.equity, closed },
  });
  await notify(user.id, "emergency_stop", "Equity guardian: positions flattened",
    `${breaches.join("; ")}. Closed ${closed.length} position(s) and paused the bot. Review before resuming.`);
  broadcast("emergency_stop", { closed, reason: "equity_guardian" });
}
