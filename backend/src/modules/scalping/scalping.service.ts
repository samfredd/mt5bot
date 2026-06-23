import type { User } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit, logError } from "../../lib/audit.js";
import { mt5, type Position } from "../mt5/client.js";
import { detectSession } from "../analysis/engine.js";
import { assessNewsRisk } from "../news/service.js";
import { executeTrade } from "../trading/service.js";
import type { TradeProposal } from "../risk/engine.js";
import { fallbackTradingSpec, moneyForPriceMove, priceDistanceFromPoints, type TradingInstrumentSpec } from "../risk/instruments.js";
import { operationalTradingAvailable, getBotState } from "../system/state.js";
import { marketKey } from "../trading/symbol-lock.js";
import { notify } from "../notifications/service.js";
import { broadcast } from "../ws/hub.js";
import { getCachedPlan } from "./scalping.ai.js";
import { evaluateScalpingGate, profitTargetReached, scalpExitReason, sessionAllowed, type ScalpGateCheck } from "./scalping.risk.js";
import { getScalpingConfig, getScalpingRisk, setScalpingStatus } from "./scalping.state.js";
import {
  SCALPING_SOURCE,
  SCALPING_STRATEGY_NAME,
  type ActiveScalp,
  type ClosedScalp,
  type ScalpCloseReason,
  type ScalpExplanation,
  type ScalpingStatus,
} from "./scalping.types.js";
import type { ScalpingConfig, ScalpingRiskConfig } from "./scalping.schema.js";

/**
 * Scalping orchestration. Scalping owns its entry risk settings:
 *
 *   Scalping Worker → scalping risk layer (evaluateScalpingGate)
 *                   → MT5 bridge (executeTrade)
 *
 * The main strategy bot's global RiskSettings do not veto scalping entries.
 * System-level controls still apply: emergency stop, Redis/operational
 * availability, broker acceptance, and protective exits.
 *
 * Scalping trades reuse the existing `Trade` model, tagged via
 * `explanation.source = "SCALPING_MODE"`, so the normal pipeline is untouched.
 */

const SCALP_TRADE_FILTER = { explanation: { path: ["source"], equals: SCALPING_SOURCE } } as const;

function dayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function adminUser(): Promise<User | null> {
  return prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
}

/** Smallest tradeable lot for the instrument, clamped to the scalping max lot. */
export function scalpLotSize(spec: TradingInstrumentSpec, maxLot: number): number {
  const step = Math.max(spec.volumeStep, 1e-8);
  const lots = Math.min(Math.max(spec.volumeMin, step), Math.min(maxLot, spec.volumeMax));
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(lots.toFixed(decimals));
}

/**
 * Risk-based lot size: choose the volume so that hitting the stop loses about
 * `riskPct`% of `balance`. Lot size here is a RISK MULTIPLIER sized off the stop
 * distance — NOT a profit target. The lot scales with the account: on a small
 * ($500) account it naturally stays near the broker minimum (~0.01) and only
 * grows once the balance (or a wider stop) justifies it — it never blindly jumps
 * to 0.10. Floors to the lot step so the realized risk never EXCEEDS the target,
 * and never drops below the broker minimum.
 *
 *   lots = (balance × riskPct/100) / money-lost-per-1.0-lot-at-the-stop
 */
export function riskBasedLotSize(
  balance: number,
  riskPct: number,
  stopLossPoints: number,
  spec: TradingInstrumentSpec,
  maxLot: number,
): number {
  const step = Math.max(spec.volumeStep, 1e-8);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const minLot = Math.max(spec.volumeMin, step);
  const ceilLot = Math.min(maxLot, spec.volumeMax);

  const riskAmount = balance * (riskPct / 100);
  const slPrice = priceDistanceFromPoints(stopLossPoints, spec);
  const moneyPerLot = moneyForPriceMove(slPrice, 1, spec);
  // Fall back to the fixed minimum lot if we cannot price the stop (missing
  // metadata, zero balance, etc.) — never guess a size.
  if (!(riskAmount > 0) || !(moneyPerLot > 0)) return scalpLotSize(spec, maxLot);

  const rawLots = riskAmount / moneyPerLot;
  const flooredToStep = Math.floor(rawLots / step) * step;
  const clamped = Math.min(Math.max(flooredToStep, minLot), ceilLot);
  return Number(clamped.toFixed(decimals));
}

/**
 * Convert money targets into protective broker SL/TP. The worker closes early
 * on FLOATING money (the primary exit); these prices are a backstop in case the
 * worker or bridge dies, and they satisfy broker-side SL/TP requirements.
 * Distances are floored to a sane minimum so the broker accepts the order; the
 * money ratio (and thus R:R) is preserved when flooring kicks in.
 */
export function moneyDerivedStops(
  direction: "buy" | "sell",
  entry: number,
  lots: number,
  spec: TradingInstrumentSpec,
  targetMoney: number,
  lossMoney: number,
  spreadPoints: number,
): { stopLoss: number; takeProfit: number } | null {
  const perLotPerPrice = moneyForPriceMove(1, lots, spec);
  if (perLotPerPrice <= 0) return null;
  let slDist = lossMoney / perLotPerPrice;
  let tpDist = targetMoney / perLotPerPrice;
  const minDist = Math.max((spec.stopsLevelPoints + 2) * spec.point, spreadPoints * spec.point * 1.5, spec.point * 5);
  if (slDist < minDist) {
    slDist = minDist;
    tpDist = slDist * (targetMoney / lossMoney);
  }
  const round = (v: number) => Number(v.toFixed(spec.digits));
  return {
    stopLoss: direction === "buy" ? round(entry - slDist) : round(entry + slDist),
    takeProfit: direction === "buy" ? round(entry + tpDist) : round(entry - tpDist),
  };
}

/**
 * Protective SL/TP prices from explicit point distances (the "points" basis).
 * Clamps below the broker's minimum stop distance just like the money basis.
 */
export function pointsDerivedStops(
  direction: "buy" | "sell",
  entry: number,
  spec: TradingInstrumentSpec,
  takeProfitPoints: number,
  stopLossPoints: number,
  spreadPoints: number,
): { stopLoss: number; takeProfit: number } {
  const minDist = Math.max((spec.stopsLevelPoints + 2) * spec.point, spreadPoints * spec.point * 1.5, spec.point * 5);
  const slDist = Math.max(stopLossPoints * spec.point, minDist);
  const tpDist = Math.max(takeProfitPoints * spec.point, minDist);
  const round = (v: number) => Number(v.toFixed(spec.digits));
  return {
    stopLoss: direction === "buy" ? round(entry - slDist) : round(entry + slDist),
    takeProfit: direction === "buy" ? round(entry + tpDist) : round(entry - tpDist),
  };
}

/** Dispatch to the configured stop basis. Falls back to money if points is
 * selected without both point values set. */
export function deriveScalpStops(
  direction: "buy" | "sell",
  entry: number,
  lots: number,
  spec: TradingInstrumentSpec,
  risk: Pick<ScalpingRiskConfig, "stopBasis" | "targetProfitMoney" | "maxLossMoney" | "takeProfitPoints" | "stopLossPoints">,
  spreadPoints: number,
): { stopLoss: number; takeProfit: number } | null {
  if (risk.stopBasis === "points" && risk.takeProfitPoints != null && risk.stopLossPoints != null) {
    return pointsDerivedStops(direction, entry, spec, risk.takeProfitPoints, risk.stopLossPoints, spreadPoints);
  }
  return moneyDerivedStops(direction, entry, lots, spec, risk.targetProfitMoney, risk.maxLossMoney, spreadPoints);
}

/** Signed price move in points relative to the trade direction (+ = in profit). */
export function signedPointsMoved(pos: Pick<Position, "type" | "price_open" | "price_current">, point: number): number | null {
  if (!point || pos.price_current == null) return null;
  const delta = pos.type === "buy" ? pos.price_current - pos.price_open : pos.price_open - pos.price_current;
  return delta / point;
}

interface ScalpCycleContext {
  user: User;
  config: ScalpingConfig;
  risk: ScalpingRiskConfig;
  account: Awaited<ReturnType<typeof mt5.accountInfo>>;
  positions: Position[];
  emergencyStop: boolean;
  redisOk: boolean;
  active: ActiveScalp[];
  tradesToday: number;
  todayNetProfit: number;
  closed: ClosedScalp[];
}

export function scalpingPreflightBlockReason(input: {
  status: ScalpingStatus;
  enabled: boolean;
  emergencyStop: boolean;
  redisOk: boolean;
}, options: { requireRunning?: boolean } = {}): string | null {
  if (!input.enabled) return "scalping disabled";
  if (options.requireRunning !== false && input.status !== "running") return `scalping ${input.status}`;
  if (input.emergencyStop) return "global emergency stop active";
  if (!input.redisOk) return "redis unavailable — fail closed";
  return null;
}

async function buildCycleContext(): Promise<ScalpCycleContext | { error: string }> {
  const user = await adminUser();
  if (!user) return { error: "no admin user" };

  const [config, risk, state, redisOk] = await Promise.all([
    getScalpingConfig(),
    getScalpingRisk(),
    getBotState(),
    operationalTradingAvailable(),
  ]);
  const account = await mt5.accountInfo();
  const positions = await mt5.positions();

  const from = dayStart();
  const scalpTrades = await prisma.trade.findMany({
    where: { ...SCALP_TRADE_FILTER, status: "EXECUTED", mt5Ticket: { not: null } },
    select: { symbol: true, mt5Ticket: true },
  });
  const openTickets = new Set(positions.map((p) => p.ticket));
  const active: ActiveScalp[] = scalpTrades
    .filter((t) => t.mt5Ticket && openTickets.has(t.mt5Ticket))
    .map((t) => ({ symbol: t.symbol, ticket: t.mt5Ticket }));

  const [tradesToday, todayAgg, closedRows] = await Promise.all([
    prisma.trade.count({ where: { ...SCALP_TRADE_FILTER, status: { in: ["EXECUTED", "CLOSED"] }, createdAt: { gte: from } } }),
    prisma.trade.aggregate({ _sum: { profit: true }, where: { ...SCALP_TRADE_FILTER, closedAt: { gte: from } } }),
    prisma.trade.findMany({
      where: { ...SCALP_TRADE_FILTER, status: "CLOSED", closedAt: { not: null } },
      orderBy: { closedAt: "desc" },
      take: 80,
      select: { symbol: true, profit: true, closedAt: true },
    }),
  ]);

  return {
    user, config, risk, account, positions,
    emergencyStop: state.emergencyStop,
    redisOk,
    active,
    tradesToday,
    todayNetProfit: todayAgg._sum.profit ?? 0,
    closed: closedRows.map((c) => ({ symbol: c.symbol, profit: c.profit, closedAt: c.closedAt as Date })),
  };
}

function scalpingNewsSettings(risk: ScalpingRiskConfig) {
  return {
    pauseBeforeNewsMin: risk.pauseBeforeNewsMin,
    pauseAfterNewsMin: risk.pauseAfterNewsMin,
    newsRiskLimit: risk.newsRiskLimit,
    allowNewsTrading: false,
  };
}

/**
 * Attempt to open scalping entries for every eligible watchlist symbol.
 * Caller is responsible for the Redis lease (single-writer). Returns a summary.
 */
export async function attemptScalpEntries(actor = "scalping:auto", options: { requireRunning?: boolean } = {}): Promise<{
  opened: { symbol: string; direction: string; ticket: string | null }[];
  blocked: { symbol: string; reason: string }[];
  skipped: number;
}> {
  const opened: { symbol: string; direction: string; ticket: string | null }[] = [];
  const blocked: { symbol: string; reason: string }[] = [];
  let skipped = 0;

  const ctx = await buildCycleContext();
  if ("error" in ctx) {
    blocked.push({ symbol: "*", reason: ctx.error });
    return { opened, blocked, skipped };
  }
  const preflightBlock = scalpingPreflightBlockReason({
    status: ctx.config.status,
    enabled: ctx.config.enabled,
    emergencyStop: ctx.emergencyStop,
    redisOk: ctx.redisOk,
  }, options);
  if (preflightBlock) {
    blocked.push({ symbol: "*", reason: preflightBlock });
    return { opened, blocked, skipped };
  }
  const entryConfig: ScalpingConfig = options.requireRunning === false
    ? { ...ctx.config, status: "running", enabled: true }
    : ctx.config;

  const active = [...ctx.active]; // mutated as we open within this cycle
  const session = detectSession();
  const todayClosed = ctx.closed.filter((c) => c.closedAt >= dayStart());

  for (const symbol of ctx.config.symbols) {
    const plan = getCachedPlan(symbol);
    // No fresh plan (or no technical direction) → no fire. In STRICT this is the
    // fail-closed path when the AI/analysis is stale or unavailable.
    if (!plan || !plan.direction) {
      skipped++;
      continue;
    }
    const direction = plan.direction;

    let tick;
    try {
      tick = await mt5.tick(symbol);
    } catch {
      skipped++;
      continue;
    }
    const news = ctx.risk.pauseDuringNews
      ? await assessNewsRisk(symbol, scalpingNewsSettings(ctx.risk)).catch(() => null)
      : null;

    const lastClosedForSymbol = ctx.closed.find((c) => marketKey(c.symbol) === marketKey(symbol)) ?? null;
    const gate = evaluateScalpingGate({
      config: entryConfig,
      risk: ctx.risk,
      symbol,
      direction,
      globalEmergencyStop: ctx.emergencyStop,
      redisAvailable: ctx.redisOk,
      active,
      tradesToday: ctx.tradesToday + opened.length,
      lastClosedForSymbol,
      recentClosedDesc: todayClosed,
      todayNetProfit: ctx.todayNetProfit,
      balance: ctx.account.balance,
      spreadPoints: tick.spread_points,
      session,
      newsAction: news?.action ?? "allow",
      ai: plan.ai,
      now: Date.now(),
    });
    if (!gate.ok) {
      blocked.push({ symbol, reason: gate.reason });
      continue;
    }

    // --- Sizing + protective stops ---
    const instrumentSpec = await mt5.symbolInfo(symbol).catch(() => fallbackTradingSpec(symbol, tick.ask));
    // Risk-based sizing requires a known stop distance (points basis). When that
    // isn't configured, fall back to the original fixed minimum lot so behavior
    // is never broken by a half-set config.
    const lots = ctx.risk.lotMode === "risk_percent" && ctx.risk.stopBasis === "points" && ctx.risk.stopLossPoints != null
      ? riskBasedLotSize(ctx.account.balance, ctx.risk.riskPerTradePercent, ctx.risk.stopLossPoints, instrumentSpec, ctx.risk.maxLotSize)
      : scalpLotSize(instrumentSpec, ctx.risk.maxLotSize);
    const entry = direction === "buy" ? tick.ask : tick.bid;
    const stops = deriveScalpStops(direction, entry, lots, instrumentSpec, ctx.risk, tick.spread_points);
    if (!stops) {
      blocked.push({ symbol, reason: "could not derive protective stops" });
      continue;
    }

    const proposal: TradeProposal = {
      symbol, direction, lots, entry, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit, instrumentSpec,
    };

    const explanation: ScalpExplanation = {
      source: SCALPING_SOURCE,
      strategyName: SCALPING_STRATEGY_NAME,
      aiDecisionId: plan.ai?.aiDecisionId ?? null,
      scalpingRiskSnapshot: {
        targetProfitMoney: ctx.risk.targetProfitMoney,
        maxLossMoney: ctx.risk.maxLossMoney,
        maxLotSize: ctx.risk.maxLotSize,
        aiMode: entryConfig.aiMode,
        useAiFireControl: entryConfig.useAiFireControl,
      },
      scalping: true,
      direction,
      technical: { score: plan.score, reasons: plan.reasons },
      ai: plan.ai,
      scalpingGate: gate.checks,
    };

    try {
      const trade = await executeTrade(ctx.user, proposal, {
        aiLogId: plan.ai?.aiDecisionId ?? undefined,
        explanation: explanation as unknown as Record<string, unknown>,
        mode: "AUTO",
        actor,
        expectedSpreadPoints: tick.spread_points,
        actualSpreadPoints: tick.spread_points,
      });
      opened.push({ symbol, direction, ticket: trade.mt5Ticket });
      active.push({ symbol, ticket: trade.mt5Ticket });
      await audit({
        actor, userId: ctx.user.id, category: "trade", action: "scalp_opened",
        detail: { symbol, direction, lots: proposal.lots, tradeId: trade.id, entry: proposal.entry, sl: proposal.stopLoss, tp: proposal.takeProfit, aiConfidence: plan.ai?.confidence ?? null },
      });
      broadcast("scalping", { event: "opened", symbol, direction, lots: proposal.lots, tradeId: trade.id });
    } catch (err) {
      blocked.push({ symbol, reason: `execution failed: ${err instanceof Error ? err.message : String(err)}` });
      await logError("scalping", "execution failed", { symbol, error: String(err) });
    }
  }
  return { opened, blocked, skipped };
}

/**
 * Protective exit pass — close scalping positions that hit their money target /
 * max loss / session-end / news-flatten / equity-guardian condition. Safe to run
 * regardless of run-state (protecting open positions is not opening new ones).
 */
export async function manageOpenScalps(actor = "scalping:manager"): Promise<{ closed: { symbol: string; reason: ScalpCloseReason; profit: number }[] }> {
  const closed: { symbol: string; reason: ScalpCloseReason; profit: number }[] = [];
  const [config, risk] = await Promise.all([getScalpingConfig(), getScalpingRisk()]);

  // Session profit goal: once today's net realized scalp P/L reaches the target,
  // flatten every open scalp and halt the engine. Evaluated before the open-
  // position early-returns so the halt also fires when already flat.
  const todayNet = risk.profitTargetMoney != null
    ? (await prisma.trade.aggregate({ _sum: { profit: true }, where: { ...SCALP_TRADE_FILTER, closedAt: { gte: dayStart() } } }))._sum.profit ?? 0
    : 0;
  const targetHit = profitTargetReached(todayNet, risk.profitTargetMoney);

  let positions: Position[] = [];
  try {
    positions = await mt5.positions();
  } catch {
    return { closed };
  }

  const scalpTrades = positions.length
    ? await prisma.trade.findMany({ where: { ...SCALP_TRADE_FILTER, status: "EXECUTED", mt5Ticket: { not: null } } })
    : [];
  const posByTicket = new Map(positions.map((p) => [p.ticket, p]));

  const session = detectSession();
  const sessionEnded = !sessionAllowed(session, risk.allowedSessions);
  const specCache = new Map<string, TradingInstrumentSpec>();

  for (const trade of scalpTrades) {
    const pos = trade.mt5Ticket ? posByTicket.get(trade.mt5Ticket) : undefined;
    if (!pos) continue;
    const profit = pos.profit;

    let reason: ScalpCloseReason | null;
    if (targetHit) {
      reason = "SCALP_PROFIT_TARGET"; // goal reached — lock in by flattening everything
    } else {
      let pointsMoved: number | null = null;
      if (risk.stopBasis === "points") {
        let spec = specCache.get(pos.symbol);
        if (!spec) {
          spec = await mt5.symbolInfo(pos.symbol).catch(() => fallbackTradingSpec(pos.symbol, pos.price_current ?? pos.price_open));
          specCache.set(pos.symbol, spec);
        }
        pointsMoved = signedPointsMoved(pos, spec.point);
      }
      reason = scalpExitReason({ profit, pointsMoved }, risk);
      if (!reason && sessionEnded) reason = "SCALP_SESSION_END";
      else if (!reason && risk.flattenBeforeHighImpactNews) {
        const news = await assessNewsRisk(pos.symbol, scalpingNewsSettings(risk)).catch(() => null);
        if (news && (news.action === "pause" || news.level === "high")) reason = "SCALP_NEWS_FLATTEN";
      }
    }
    if (!reason) continue;

    const result = await mt5.closePosition(pos.ticket, `scalping:${reason}`).catch(() => ({ ok: false as const }));
    if (!result.ok) continue;
    const realized = (result as { profit?: number }).profit ?? profit;
    const prevExplanation = (trade.explanation ?? {}) as Record<string, unknown>;
    await prisma.trade.update({
      where: { id: trade.id },
      data: { status: "CLOSED", closedAt: new Date(), profit: realized, explanation: { ...prevExplanation, closeReason: reason } as object },
    });
    await audit({ actor, userId: trade.userId, category: "trade", action: "scalp_closed", detail: { tradeId: trade.id, ticket: pos.ticket, symbol: pos.symbol, reason, profit: realized } });
    await notify(trade.userId, profit >= 0 ? "take_profit_hit" : "stop_loss_hit", `Scalp closed: ${pos.symbol}`, `${reason} — P/L ${realized >= 0 ? "+" : ""}${realized.toFixed(2)}`);
    broadcast("scalping", { event: "closed", symbol: pos.symbol, reason, profit: realized, tradeId: trade.id });
    closed.push({ symbol: pos.symbol, reason, profit: realized });
  }

  // Halt once the goal is hit (also when flat) so no new entries open.
  if (targetHit && config.status === "running") {
    await setScalpingStatus("stopped", "scalping:profit-target");
    await audit({ actor, category: "system", action: "scalp_profit_target_halt", detail: { todayNet, target: risk.profitTargetMoney, flattened: closed.length } });
    const admin = await adminUser();
    if (admin) {
      await notify(admin.id, "take_profit_hit", "Scalping profit goal reached", `Net +${todayNet.toFixed(2)} ≥ goal ${risk.profitTargetMoney} — flattened ${closed.length} and stopped.`);
    }
    broadcast("scalping", { event: "profit_target_halt", todayNet, target: risk.profitTargetMoney, flattened: closed.length });
  }
  return { closed };
}

/** One full manual cycle (refresh handled by the caller) — used by /run-once. */
export async function runScalpingCycleOnce(actor: string): Promise<{
  managed: Awaited<ReturnType<typeof manageOpenScalps>>;
  entries: Awaited<ReturnType<typeof attemptScalpEntries>>;
}> {
  const managed = await manageOpenScalps(actor);
  const entries = await attemptScalpEntries(actor, { requireRunning: false });
  return { managed, entries };
}

/** Trades opened by scalping mode only. */
export async function listScalpingTrades(limit = 50) {
  return prisma.trade.findMany({
    where: SCALP_TRADE_FILTER,
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
  });
}

/** Active (still-open at the broker) scalping trades, for the status panel. */
export async function listActiveScalps(): Promise<{ symbol: string; ticket: string | null; checks?: ScalpGateCheck[] }[]> {
  let positions: Position[] = [];
  try {
    positions = await mt5.positions();
  } catch { /* bridge down — report none active */ }
  const open = new Set(positions.map((p) => p.ticket));
  const trades = await prisma.trade.findMany({
    where: { ...SCALP_TRADE_FILTER, status: "EXECUTED", mt5Ticket: { not: null } },
    select: { symbol: true, mt5Ticket: true },
  });
  return trades.filter((t) => t.mt5Ticket && open.has(t.mt5Ticket)).map((t) => ({ symbol: t.symbol, ticket: t.mt5Ticket }));
}

/** Scalping-specific performance metrics from closed scalping trades. */
export async function scalpingPerformance(): Promise<{
  totalClosed: number; wins: number; losses: number; winRate: number;
  grossProfit: number; grossLoss: number; netProfit: number; profitFactor: number | null;
  avgWin: number; avgLoss: number; todayNet: number; openCount: number;
}> {
  const closed = await prisma.trade.findMany({
    where: { ...SCALP_TRADE_FILTER, status: "CLOSED" },
    select: { profit: true, closedAt: true },
  });
  const from = dayStart();
  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, todayNet = 0;
  for (const t of closed) {
    const p = t.profit ?? 0;
    if (p >= 0) { wins++; grossProfit += p; } else { losses++; grossLoss += p; }
    if (t.closedAt && t.closedAt >= from) todayNet += p;
  }
  const totalClosed = closed.length;
  const active = await listActiveScalps();
  return {
    totalClosed, wins, losses,
    winRate: totalClosed ? Number((wins / totalClosed).toFixed(3)) : 0,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    netProfit: Number((grossProfit + grossLoss).toFixed(2)),
    profitFactor: grossLoss < 0 ? Number((grossProfit / -grossLoss).toFixed(2)) : null,
    avgWin: wins ? Number((grossProfit / wins).toFixed(2)) : 0,
    avgLoss: losses ? Number((grossLoss / losses).toFixed(2)) : 0,
    todayNet: Number(todayNet.toFixed(2)),
    openCount: active.length,
  };
}
