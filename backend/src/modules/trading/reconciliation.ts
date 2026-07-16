import { prisma } from "../../lib/prisma.js";
import { logError } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { notify } from "../notifications/service.js";
import { broadcast } from "../ws/hub.js";
import { reportIncident } from "../incidents/service.js";
import { finalizeExecutionComparison } from "./execution-comparison.js";
import { releaseMarketReservation } from "./execution-intent.js";

export async function expirePendingTradeApprovals(now = new Date()): Promise<number> {
  const expired = await prisma.tradeApproval.findMany({
    where: { status: "pending", expiresAt: { lte: now }, trade: { status: "PENDING_APPROVAL" } },
    select: { id: true, tradeId: true },
    take: 500,
  });
  let count = 0;
  for (const approval of expired) {
    const claimed = await prisma.trade.updateMany({
      where: { id: approval.tradeId, status: "PENDING_APPROVAL" },
      data: { status: "CANCELLED" },
    });
    if (claimed.count !== 1) continue;
    await prisma.tradeApproval.update({ where: { id: approval.id }, data: { status: "expired" } });
    count += 1;
  }
  return count;
}

async function reconcilePendingIntents(positions: Awaited<ReturnType<typeof mt5.positions>>) {
  const pending = await prisma.orderIntent.findMany({ where: { status: { in: ["SUBMITTING", "PLACED", "PARTIALLY_FILLED", "UNKNOWN"] } }, include: { trade: true }, take: 200 });
  for (const intent of pending) {
    // Older clients could produce a 32-character comment that MT5 truncated;
    // the stable prefix remains collision-resistant enough for recovery.
    const matchKey = intent.clientOrderId.slice(0, 20);
    const position = positions.find((item) => item.comment?.includes(matchKey));
    if (!position) continue;
    await prisma.$transaction([
      prisma.orderIntent.update({ where: { id: intent.id }, data: { status: "FILLED", filledVolume: position.volume, brokerPositionId: position.ticket, resolvedAt: new Date(), error: null } }),
      prisma.trade.update({ where: { id: intent.tradeId }, data: { status: "EXECUTED", mt5Ticket: position.ticket, lots: position.volume, entryPrice: position.price_open, openedAt: intent.trade.openedAt ?? new Date() } }),
    ]);
  }
  return pending.filter((intent) => !positions.some((item) => item.comment?.includes(intent.clientOrderId.slice(0, 20))));
}

/**
 * Reconcile DB trades against the broker: detect SL/TP closures and pull the
 * realized profit from deal history. Analytics and the loss-streak circuit
 * breaker both depend on accurate per-trade profit.
 */
export async function syncClosedTrades(): Promise<void> {
  // Only reconcile trades belonging to the account the terminal is connected
  // to. Another account's open trades are not visible right now, not closed.
  const info = await mt5.accountInfo().catch(() => null);
  if (!info) return;
  const accountScope = { OR: [{ accountId: null }, { account: { login: String(info.login) } }] };
  const positions = await mt5.positions();
  const unresolvedIntents = await reconcilePendingIntents(positions);

  const open = await prisma.trade.findMany({
    where: { status: { in: ["EXECUTED", "PARTIALLY_FILLED"] }, mt5Ticket: { not: null }, ...accountScope },
    include: { orderIntent: { select: { id: true } } },
  });
  const needBackfill = await prisma.trade.findMany({
    where: {
      status: "CLOSED",
      profit: null,
      mt5Ticket: { not: null },
      closedAt: { gte: new Date(Date.now() - 7 * 86400_000) },
      ...accountScope,
    },
  });
  if (!open.length && !needBackfill.length && !unresolvedIntents.length) return;

  const liveTickets = new Set(positions.map((position) => position.ticket));
  const justClosed = open.filter((trade) => !liveTickets.has(trade.mt5Ticket!));
  if (!justClosed.length && !needBackfill.length && !unresolvedIntents.length) return;

  // Real MT5 deals carry position_id; the mock uses the position ticket.
  // Net profit is the sum of every deal attributed to the position.
  let deals: { ticket?: string; position_id?: string; profit?: number; commission?: number; swap?: number; fee?: number; price?: number; time?: string; comment?: string }[] = [];
  let historyError: string | null = null;
  try {
    deals = (await mt5.history(7)) as typeof deals;
  } catch (err) {
    // History may lag a closure. Store null and retry through the backfill path.
    historyError = String(err);
  }
  // Loud, aggregated signal when there is work to attribute but the broker
  // returned no deal history at all — the difference between "one closure is
  // lagging" and "every closure is unattributable because the deal feed is
  // empty/stale". The latter silently disables loss controls, so surface it.
  const pendingAttribution = justClosed.length + needBackfill.length;
  if (pendingAttribution > 0 && deals.length === 0) {
    await logError("reconciliation", "deal history empty while trades await attribution", {
      pendingAttribution,
      justClosed: justClosed.length,
      needBackfill: needBackfill.length,
      historyError,
    });
    await reportIncident({
      dedupeKey: "reconciliation:deal-history-empty",
      severity: "CRITICAL",
      source: "reconciliation",
      title: "Broker deal history is empty",
      message: `${pendingAttribution} closed trade(s) cannot be attributed because the bridge returned no deal history. Per-trade P/L, analytics, and loss controls are blind until this clears.`,
      context: { pendingAttribution, justClosed: justClosed.length, needBackfill: needBackfill.length, historyError },
    });
  }
  const dealsFor = (ticket: string) => deals.filter((deal) => (deal.position_id ?? deal.ticket) === ticket);
  const profitFor = (ticket: string): number | null => {
    const matched = dealsFor(ticket);
    return matched.length
      ? Number(matched.reduce((total, deal) => total + (deal.profit ?? 0) + (deal.commission ?? 0) + (deal.swap ?? 0) + (deal.fee ?? 0), 0).toFixed(2))
      : null;
  };

  // Recover submissions whose HTTP result was lost. An opening deal carries
  // the client id and yields the durable broker position id even if that
  // position opened and closed between reconciliation polls.
  for (const intent of unresolvedIntents) {
    const openingDeal = deals.find((deal) => deal.comment?.includes(intent.clientOrderId.slice(0, 20)));
    const positionId = openingDeal?.position_id ?? openingDeal?.ticket;
    if (!positionId) continue;
    const stillOpen = positions.some((position) => position.ticket === positionId);
    const realizedProfit = stillOpen ? null : profitFor(positionId);
    await prisma.$transaction([
      prisma.orderIntent.update({ where: { id: intent.id }, data: {
        status: "FILLED", brokerPositionId: positionId, brokerDealId: openingDeal?.ticket,
        filledVolume: intent.requestedVolume, resolvedAt: new Date(), error: null,
      } }),
      prisma.trade.update({ where: { id: intent.tradeId }, data: {
        status: stillOpen ? "EXECUTED" : "CLOSED", mt5Ticket: positionId,
        openedAt: intent.trade.openedAt ?? new Date(),
        ...(stillOpen ? {} : { closedAt: new Date(), profit: realizedProfit,
          attributionConfidence: realizedProfit === null ? 0 : 1,
          attributionReason: realizedProfit === null ? "deal_history_missing" : "recovered_client_order_id" }),
      } }),
    ]);
    if (!stillOpen) await releaseMarketReservation(intent.id);
  }

  const groupedClosed = new Map<string, typeof justClosed>();
  for (const trade of justClosed) {
    const group = groupedClosed.get(trade.mt5Ticket!) ?? [];
    group.push(trade);
    groupedClosed.set(trade.mt5Ticket!, group);
  }

  for (const [positionId, trades] of groupedClosed) {
    if (trades.length > 1) {
      await reportIncident({
        dedupeKey: `reconciliation:ambiguous:${positionId}`,
        severity: "CRITICAL",
        source: "reconciliation",
        title: `Ambiguous netting attribution: ${trades[0].symbol}`,
        message: `${trades.length} bot trades map to broker position ${positionId}; per-trade profit is excluded.`,
        context: { positionId, tradeIds: trades.map((trade) => trade.id) },
      });
      for (const trade of trades) {
        const closed = await prisma.trade.update({
          where: { id: trade.id },
          data: {
            status: "CLOSED",
            closedAt: new Date(),
            profit: null,
            attributionConfidence: 0,
            attributionReason: "ambiguous_netting_position",
          },
        });
        await notify(trade.userId, "trade_closed", `Trade closed: ${trade.symbol}`, `Position ${positionId} closed; P/L attribution is ambiguous and excluded.`);
        if (trade.orderIntent) await releaseMarketReservation(trade.orderIntent.id);
        broadcast("trade", { tradeId: closed.id, status: "CLOSED" });
      }
      continue;
    }
    const trade = trades[0];
    const profit = profitFor(trade.mt5Ticket!);
    if (profit === null) {
      await logError("scheduler", "trade closed without attributable profit", {
        tradeId: trade.id,
        symbol: trade.symbol,
        positionId: trade.mt5Ticket,
      });
      await reportIncident({
        dedupeKey: `reconciliation:unattributed:${trade.id}`,
        severity: "CRITICAL",
        source: "reconciliation",
        title: `Unattributed closed trade: ${trade.symbol}`,
        message: "The broker position closed without matching deal history; per-trade loss controls exclude this result until backfill succeeds.",
        context: { tradeId: trade.id, symbol: trade.symbol, positionId: trade.mt5Ticket },
      });
    }
    const closed = await prisma.trade.update({
      where: { id: trade.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        profit,
        attributionConfidence: profit === null ? 0 : 1,
        attributionReason: profit === null ? "deal_history_missing" : "unique_position_match",
        brokerExitPrice: dealsFor(trade.mt5Ticket!).at(-1)?.price ?? null,
      },
    });
    const actualExit = dealsFor(trade.mt5Ticket!).at(-1)?.price;
    if (profit !== null) {
      await finalizeExecutionComparison({
        tradeId: trade.id,
        actualExit,
        actualPnl: profit,
        attributionConfidence: 1,
        attributionReason: "unique_position_match",
      });
    }
    await notify(
      trade.userId,
      "trade_closed",
      `Trade closed: ${trade.symbol}`,
      `Ticket ${trade.mt5Ticket} closed (SL/TP hit or closed at broker).${profit !== null ? ` Realized P/L: ${profit.toFixed(2)}` : ""}`,
    );
    const intent = await prisma.orderIntent.findUnique({ where: { tradeId: trade.id }, select: { id: true } });
    if (intent) await releaseMarketReservation(intent.id);
    broadcast("trade", { tradeId: closed.id, status: "CLOSED" });
  }

  const backfillCounts = new Map<string, number>();
  for (const trade of needBackfill) backfillCounts.set(trade.mt5Ticket!, (backfillCounts.get(trade.mt5Ticket!) ?? 0) + 1);
  for (const trade of needBackfill) {
    if ((backfillCounts.get(trade.mt5Ticket!) ?? 0) > 1) {
      await reportIncident({
        dedupeKey: `reconciliation:ambiguous:${trade.mt5Ticket}`,
        severity: "CRITICAL",
        source: "reconciliation",
        title: `Ambiguous netting attribution: ${trade.symbol}`,
        message: "Multiple closed bot trades share this broker position; backfill remains excluded.",
        context: { positionId: trade.mt5Ticket },
      });
      continue;
    }
    const profit = profitFor(trade.mt5Ticket!);
    if (profit !== null) {
      const actualExit = dealsFor(trade.mt5Ticket!).at(-1)?.price;
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          profit,
          attributionConfidence: 1,
          attributionReason: "unique_position_match",
          brokerExitPrice: actualExit ?? null,
        },
      });
      await finalizeExecutionComparison({
        tradeId: trade.id,
        actualExit,
        actualPnl: profit,
        attributionConfidence: 1,
        attributionReason: "unique_position_match",
      });
    }
  }
}
