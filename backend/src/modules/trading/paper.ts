import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { mt5 } from "../mt5/client.js";
import type { TradeProposal } from "../risk/engine.js";
import { fallbackTradingSpec, moneyForPriceMove, type TradingInstrumentSpec } from "../risk/instruments.js";
import { reportIncident } from "../incidents/service.js";
import { getOperationalConfig } from "../system/operational-config.js";

const money = (value: number) => Number(value.toFixed(2));
const price = (value: number, digits: number) => Number(value.toFixed(digits));
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

interface PaperTick {
  bid: number;
  ask: number;
  spread_points: number;
  time: string;
}

export type PromotablePaperTrade = {
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  instrumentSpec: unknown;
};

/**
 * Rebuild a paper setup around the current executable price. The original
 * stop/target distances are preserved, but a setup that has already moved by
 * more than half its initial risk is stale and must be analyzed again.
 */
export function buildPaperPromotionProposal(
  trade: PromotablePaperTrade,
  currentEntry: number,
  requestedLots?: number,
): { ok: true; proposal: TradeProposal; driftR: number } | { ok: false; error: string } {
  if (!trade.stopLoss || !trade.takeProfit) {
    return { ok: false, error: "Paper setup must have both a stop-loss and take-profit before broker execution." };
  }
  const isBuy = trade.direction === "BUY";
  const stopDistance = isBuy ? trade.entryPrice - trade.stopLoss : trade.stopLoss - trade.entryPrice;
  const targetDistance = isBuy ? trade.takeProfit - trade.entryPrice : trade.entryPrice - trade.takeProfit;
  if (!(stopDistance > 0) || !(targetDistance > 0)) {
    return { ok: false, error: "Paper setup has invalid stop-loss or take-profit geometry." };
  }
  const driftR = Math.abs(currentEntry - trade.entryPrice) / stopDistance;
  if (driftR > 0.5) {
    return { ok: false, error: `Paper setup is stale: price moved ${driftR.toFixed(2)}R from its paper entry. Run a fresh analysis.` };
  }
  const spec = trade.instrumentSpec as TradingInstrumentSpec;
  const round = (value: number) => price(value, spec.digits);
  return {
    ok: true,
    driftR,
    proposal: {
      symbol: trade.symbol,
      direction: isBuy ? "buy" : "sell",
      lots: requestedLots ?? trade.lots,
      entry: currentEntry,
      stopLoss: round(isBuy ? currentEntry - stopDistance : currentEntry + stopDistance),
      takeProfit: round(isBuy ? currentEntry + targetDistance : currentEntry - targetDistance),
      instrumentSpec: spec,
    },
  };
}

export async function openPaperTrade(input: {
  userId: string;
  strategyId?: string;
  proposal: TradeProposal;
  tick: PaperTick;
  expectedSlippagePoints?: number;
  commissionPerLot?: number;
  explanation?: Record<string, unknown>;
}) {
  const spec = input.proposal.instrumentSpec ?? fallbackTradingSpec(input.proposal.symbol, input.proposal.entry);
  const slippagePoints = Math.max(0, input.expectedSlippagePoints ?? 2);
  const slippage = slippagePoints * spec.point;
  const executable = input.proposal.direction === "buy" ? input.tick.ask : input.tick.bid;
  const entryPrice = price(
    input.proposal.direction === "buy" ? executable + slippage : executable - slippage,
    spec.digits,
  );
  return prisma.paperTrade.create({
    data: {
      userId: input.userId,
      strategyId: input.strategyId,
      symbol: input.proposal.symbol,
      direction: input.proposal.direction === "buy" ? "BUY" : "SELL",
      lots: input.proposal.lots,
      proposedEntry: input.proposal.entry,
      entryPrice,
      stopLoss: input.proposal.stopLoss,
      takeProfit: input.proposal.takeProfit,
      expectedSpreadPoints: input.tick.spread_points,
      expectedSlippagePoints: slippagePoints,
      expectedCommission: money((input.commissionPerLot ?? 7) * input.proposal.lots),
      instrumentSpec: json(spec),
      marketSnapshot: json(input.tick),
      explanation: json(input.explanation ?? {}),
      status: "OPEN",
      openedAt: new Date(input.tick.time),
      lastMarkedAt: new Date(input.tick.time),
    },
  });
}

function exitFor(
  trade: { direction: "BUY" | "SELL"; stopLoss: number | null; takeProfit: number | null },
  tick: PaperTick,
): { exitPrice: number; exitReason: "stop_loss" | "take_profit" } | null {
  const executable = trade.direction === "BUY" ? tick.bid : tick.ask;
  if (trade.direction === "BUY") {
    if (trade.stopLoss !== null && executable <= trade.stopLoss) return { exitPrice: executable, exitReason: "stop_loss" };
    if (trade.takeProfit !== null && executable >= trade.takeProfit) return { exitPrice: executable, exitReason: "take_profit" };
  } else {
    if (trade.stopLoss !== null && executable >= trade.stopLoss) return { exitPrice: executable, exitReason: "stop_loss" };
    if (trade.takeProfit !== null && executable <= trade.takeProfit) return { exitPrice: executable, exitReason: "take_profit" };
  }
  return null;
}

export async function reconcilePaperTrades(now = new Date()) {
  const { paperTradeStaleTickMin } = await getOperationalConfig();
  const staleTickMs = paperTradeStaleTickMin * 60_000;
  const openTrades = await prisma.paperTrade.findMany({ where: { status: "OPEN" } });
  const ticks = new Map<string, PaperTick>();
  for (const trade of openTrades) {
    let tick = ticks.get(trade.symbol);
    try {
      tick ??= await mt5.tick(trade.symbol);
      ticks.set(trade.symbol, tick);
    } catch (error) {
      if (now.getTime() - trade.openedAt.getTime() >= staleTickMs) {
        await reportIncident({
          dedupeKey: `paper-trade:stale:${trade.id}`,
          severity: "WARNING",
          source: "paper-trading",
          title: `Paper trade ${trade.symbol} has no fresh tick`,
          message: String(error),
          context: { paperTradeId: trade.id, openedAt: trade.openedAt.toISOString() },
        });
      }
      continue;
    }
    if (now.getTime() - Date.parse(tick.time) > staleTickMs) {
      await reportIncident({
        dedupeKey: `paper-trade:stale:${trade.id}`,
        severity: "WARNING",
        source: "paper-trading",
        title: `Paper trade ${trade.symbol} has a stale tick`,
        message: `Last tick was ${tick.time}`,
        context: { paperTradeId: trade.id, tickTime: tick.time },
      });
      continue;
    }
    const resolved = exitFor(trade, tick);
    if (!resolved) {
      await prisma.paperTrade.update({
        where: { id: trade.id },
        data: { lastMarkedAt: new Date(tick.time), marketSnapshot: json(tick) },
      });
      continue;
    }
    const spec = trade.instrumentSpec as unknown as TradingInstrumentSpec;
    const signedMove = trade.direction === "BUY"
      ? resolved.exitPrice - trade.entryPrice
      : trade.entryPrice - resolved.exitPrice;
    const profit = money(moneyForPriceMove(signedMove, trade.lots, spec) - trade.expectedCommission);
    await prisma.paperTrade.update({
      where: { id: trade.id },
      data: {
        status: "CLOSED",
        exitPrice: price(resolved.exitPrice, spec.digits),
        exitReason: resolved.exitReason,
        profit,
        closedAt: new Date(tick.time),
        lastMarkedAt: new Date(tick.time),
        marketSnapshot: json(tick),
      },
    });
  }
  return openTrades.length;
}

export async function paperPerformance(userId: string) {
  const trades = await prisma.paperTrade.findMany({ where: { userId, status: "CLOSED" } });
  const profits = trades.map((trade) => trade.profit ?? 0);
  const wins = profits.filter((profit) => profit > 0).length;
  const losses = profits.filter((profit) => profit < 0).length;
  const grossProfit = profits.filter((profit) => profit > 0).reduce((sum, profit) => sum + profit, 0);
  const grossLoss = Math.abs(profits.filter((profit) => profit < 0).reduce((sum, profit) => sum + profit, 0));
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? money((wins / trades.length) * 100) : 0,
    netPnl: money(profits.reduce((sum, profit) => sum + profit, 0)),
    profitFactor: grossLoss > 0 ? money(grossProfit / grossLoss) : null,
  };
}
