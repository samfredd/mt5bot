import { randomUUID } from "node:crypto";
import type { TradingMode, User } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { mt5, type OrderRequest, type OrderResult } from "../mt5/client.js";
import { accountIdForLogin } from "../mt5/account.js";
import type { TradeProposal } from "../risk/engine.js";
import { marketKey } from "./symbol-lock.js";

export class MarketReservationError extends Error {}

export async function prepareDurableExecution(input: {
  user: User;
  proposal: TradeProposal;
  mode: TradingMode;
  strategyId?: string;
  aiLogId?: string;
  explanation: Record<string, unknown>;
  existingTradeId?: string;
  durationMin?: number;
  maxEntriesPerMarket?: number;
}) {
  const account = await mt5.accountInfo();
  const accountId = await accountIdForLogin(input.user.id, account.login, account);
  if (!accountId) throw new Error("the connected MT5 account is not registered; execution blocked");
  const saved = await prisma.mt5Account.findUniqueOrThrow({ where: { id: accountId }, select: { login: true, server: true } });
  if (String(account.login) !== saved.login || (saved.server && account.server && saved.server !== account.server)) throw new Error("connected account changed during execution preparation");

  if (input.existingTradeId) {
    const prior = await prisma.orderIntent.findUnique({ where: { tradeId: input.existingTradeId } });
    if (prior) throw new Error(`trade already has order intent ${prior.clientOrderId} (${prior.status}); refusing duplicate submission`);
  }

  // MT5 comments are limited to 31 characters. Keep the complete id in the
  // broker comment so recovery can correlate an uncertain submission.
  const clientOrderId = `mt5b-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const baseKey = marketKey(input.proposal.symbol);
  const maxEntries = Math.max(1, Math.trunc(input.maxEntriesPerMarket ?? 1));
  if (maxEntries > 1 && account.margin_mode !== 2) {
    const detected = account.margin_mode == null ? "not reported by the MT5 bridge" : `mode ${account.margin_mode}`;
    throw new MarketReservationError(
      `Maximum trades per symbol is ${maxEntries}, but ${input.proposal.symbol} cannot use multiple entries: ` +
      `the connected account is not confirmed as an MT5 hedging account (${detected}). ` +
      "Use 1 on netting/exchange accounts, or connect a hedging account.",
    );
  }
  const spec = await mt5.symbolInfo(input.proposal.symbol);
  const stepDecimals = Math.max(0, (String(spec.volumeStep).split(".")[1] ?? "").length);
  const normalizedVolume = Number((Math.floor((Math.min(input.proposal.lots, spec.volumeMax) + 1e-12) / spec.volumeStep) * spec.volumeStep).toFixed(stepDecimals));
  if (!Number.isFinite(normalizedVolume) || normalizedVolume < spec.volumeMin) throw new Error(`requested volume is below broker minimum ${spec.volumeMin} after step normalization`);
  const normalizePrice = (value: number | null | undefined) => value == null ? undefined : Number((Math.round(value / spec.tickSize) * spec.tickSize).toFixed(spec.digits));
  const request: OrderRequest = {
    symbol: input.proposal.symbol,
    direction: input.proposal.direction,
    volume: normalizedVolume,
    sl: normalizePrice(input.proposal.stopLoss),
    tp: normalizePrice(input.proposal.takeProfit),
    comment: `mt5bot:${clientOrderId}`,
    client_order_id: clientOrderId,
    expected_login: saved.login,
    expected_server: saved.server || account.server,
  };

  try {
    return await prisma.$transaction(async (tx) => {
      const candidateKeys = maxEntries === 1
        ? [baseKey]
        : [baseKey, ...Array.from({ length: maxEntries - 1 }, (_, index) => `${baseKey}#${index + 2}`)];
      const reservations = await tx.marketReservation.findMany({
        where: { accountId, marketKey: { in: candidateKeys } },
      });
      const now = new Date();
      const key = candidateKeys.find((candidate) => {
        const reservation = reservations.find((row) => row.marketKey === candidate);
        return !reservation || reservation.status !== "ACTIVE" || reservation.expiresAt <= now;
      });
      if (!key) {
        throw new MarketReservationError(
          `${input.proposal.symbol} already has ${maxEntries}/${maxEntries} reserved or active entries; ` +
          "close an entry or increase Maximum per symbol and the account-wide limits.",
        );
      }
      const existingReservation = reservations.find((row) => row.marketKey === key);
      if (existingReservation && existingReservation.status === "ACTIVE" && existingReservation.expiresAt > new Date()) {
        throw new MarketReservationError(`${input.proposal.symbol} entry slot is reserved by another execution`);
      }
      const trade = input.existingTradeId
        ? await tx.trade.update({ where: { id: input.existingTradeId }, data: { status: "SUBMITTING", accountId, lots: normalizedVolume, explanation: input.explanation as object } })
        : await tx.trade.create({ data: {
          userId: input.user.id, accountId, strategyId: input.strategyId, symbol: input.proposal.symbol,
          direction: input.proposal.direction === "buy" ? "BUY" : "SELL", lots: normalizedVolume,
          entryPrice: input.proposal.entry, stopLoss: input.proposal.stopLoss, takeProfit: input.proposal.takeProfit,
          status: "SUBMITTING", mode: input.mode, aiAnalysisId: input.aiLogId, closeAfterMin: input.durationMin,
          explanation: input.explanation as object,
        } });
      const intent = await tx.orderIntent.create({ data: {
        clientOrderId, userId: input.user.id, accountId, tradeId: trade.id, marketKey: key,
        expectedLogin: saved.login, expectedServer: saved.server || account.server || "", request: request as object,
        requestedVolume: normalizedVolume, status: "PREPARED",
      } });
      if (existingReservation) {
        const claimed = await tx.marketReservation.updateMany({ where: { id: existingReservation.id, OR: [{ status: { not: "ACTIVE" } }, { expiresAt: { lte: new Date() } }] }, data: { intentId: intent.id, status: "ACTIVE", expiresAt: new Date(Date.now() + 24 * 3600_000), releasedAt: null, createdAt: new Date() } });
        if (claimed.count !== 1) throw new MarketReservationError(`${input.proposal.symbol} reservation changed concurrently`);
      } else {
        await tx.marketReservation.create({ data: { accountId, marketKey: key, intentId: intent.id, expiresAt: new Date(Date.now() + 24 * 3600_000) } });
      }
      return { trade, intent, request, account };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) throw new MarketReservationError(`${input.proposal.symbol} entry capacity changed concurrently; retry after the current execution finishes`);
    throw error;
  }
}

export async function markIntentSubmitting(intentId: string) {
  await prisma.orderIntent.update({ where: { id: intentId }, data: { status: "SUBMITTING", submittedAt: new Date() } });
}

export async function markIntentUnknown(intentId: string, tradeId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.$transaction([
    prisma.orderIntent.update({ where: { id: intentId }, data: { status: "UNKNOWN", error: message.slice(0, 2000) } }),
    prisma.trade.update({ where: { id: tradeId }, data: { status: "UNKNOWN" } }),
  ]);
}

export async function applyOrderResult(intentId: string, tradeId: string, result: OrderResult) {
  const intentStatus = result.status ?? (result.ok ? "FILLED" : "REJECTED");
  const tradeStatus = intentStatus === "FILLED" ? "EXECUTED" : intentStatus === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : intentStatus === "PLACED" ? "SUBMITTING" : intentStatus === "UNKNOWN" ? "UNKNOWN" : "FAILED";
  const terminal = intentStatus === "FILLED" || intentStatus === "REJECTED";
  const [intent, trade] = await prisma.$transaction([
    prisma.orderIntent.update({ where: { id: intentId }, data: {
      status: intentStatus, filledVolume: result.filled_volume ?? (result.ok ? result.requested_volume ?? 0 : 0),
      brokerOrderId: result.ticket, brokerDealId: result.deal_id, brokerPositionId: result.position_id,
      retcode: result.retcode, error: result.error, resolvedAt: terminal ? new Date() : null,
    } }),
    prisma.trade.update({ where: { id: tradeId }, data: {
      status: tradeStatus, mt5Ticket: result.position_id ?? result.ticket ?? null,
      entryPrice: result.price, openedAt: intentStatus === "FILLED" || intentStatus === "PARTIALLY_FILLED" ? new Date() : null,
      ...(result.filled_volume && result.filled_volume > 0 ? { lots: result.filled_volume } : {}),
    } }),
  ]);
  if (intentStatus === "REJECTED") await releaseMarketReservation(intentId);
  else await prisma.marketReservation.updateMany({
    where: { intentId, status: "ACTIVE" },
    // A live position must keep the market fenced until closure reconciliation
    // explicitly releases it; do not let a long-running position outlive a
    // short preparation lease and admit a duplicate order.
    data: { expiresAt: new Date(Date.now() + 365 * 86400_000) },
  });
  return { intent, trade };
}

export async function releaseMarketReservation(intentId: string) {
  await prisma.marketReservation.updateMany({ where: { intentId, status: "ACTIVE" }, data: { status: "RELEASED", releasedAt: new Date(), expiresAt: new Date() } });
}
