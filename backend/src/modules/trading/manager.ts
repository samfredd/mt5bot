import { prisma } from "../../lib/prisma.js";
import { audit, logError } from "../../lib/audit.js";
import { mt5, type Position } from "../mt5/client.js";
import { currentAccountId } from "../mt5/account.js";
import { atr, last } from "../analysis/indicators.js";
import { notify } from "../notifications/service.js";
import { normalizeCandles } from "../backtest/market-data.js";
import { calculateManagedStop } from "../backtest/execution.js";

/**
 * Professional position management, run on every scheduler tick:
 *
 *  1. Break-even: once a trade is +1R in profit, move the stop to entry
 *     (plus a 0.1R buffer) so a winner can no longer become a loser.
 *  2. ATR trailing: beyond +1.5R, trail the stop one ATR(14, H1) behind
 *     price — locking in profit while giving the trade room to breathe.
 *
 * Stops only ever RATCHET in the trade's favor; they are never widened.
 * Runs even while the bot is paused — protecting open positions is not the
 * same as opening new ones.
 */
export async function managePositions(): Promise<void> {
  let positions;
  try {
    positions = await mt5.positions();
  } catch {
    return; // bridge unreachable — nothing to manage safely
  }
  if (!positions.length) return;

  const openTrades = await prisma.trade.findMany({
    where: { status: "EXECUTED", mt5Ticket: { not: null } },
    include: { strategy: true },
  });
  const tracked = new Set(openTrades.map((t) => t.mt5Ticket));

  // Adopt positions opened OUTSIDE the bot (manually in the terminal, or
  // already open before the bot saw them) so break-even / trailing / time-exit
  // apply to them too. Their entry + current stop are captured once as the R
  // reference, so subsequent ratchets stay stable.
  const external = positions.filter((p) => !tracked.has(p.ticket));
  const adoptedTrades = external.length ? await adoptExternalPositions(external) : [];

  const byTicket = new Map(positions.map((p) => [p.ticket, p]));

  for (const trade of [...openTrades, ...adoptedTrades]) {
    const pos = byTicket.get(trade.mt5Ticket!);
    if (!pos) continue;

    // Time-based exit: the user chose a maximum duration for this trade.
    if (trade.closeAfterMin && trade.openedAt &&
        Date.now() - trade.openedAt.getTime() >= trade.closeAfterMin * 60_000) {
      const result = await mt5.closePosition(pos.ticket, "system:time-exit").catch(() => ({ ok: false as const }));
      if (result.ok) {
        await prisma.trade.update({
          where: { id: trade.id },
          data: { status: "CLOSED", closedAt: new Date(), profit: (result as { profit?: number }).profit ?? null },
        });
        await audit({
          actor: "system:time-exit", userId: trade.userId, category: "trade", action: "time_exit",
          detail: { tradeId: trade.id, ticket: pos.ticket, symbol: pos.symbol, afterMin: trade.closeAfterMin },
        });
        await notify(trade.userId, "trade_closed", `Time exit: ${pos.symbol}`,
          `Position ${pos.ticket} closed after its ${trade.closeAfterMin}-minute duration limit.`);
      }
      continue;
    }

    if (!trade.stopLoss || !trade.entryPrice) continue;

    const isBuy = pos.type === "buy";
    const entry = pos.price_open;
    // R = original risk distance (DB stopLoss is the original, never updated here)
    const r = Math.abs(trade.entryPrice - trade.stopLoss);
    if (r <= 0) continue;

    let tick;
    try {
      tick = await mt5.tick(pos.symbol);
    } catch {
      continue;
    }
    const price = isBuy ? tick.bid : tick.ask;
    const currentSl = pos.sl ?? trade.stopLoss;
    const trailingEnabled = (trade.strategy?.config as { exit?: { trailingStop?: boolean } })?.exit?.trailingStop ?? true;
    let lastAtr: number | null = null;
    if (trailingEnabled) {
      try {
        const candles = normalizeCandles(await mt5.candles(pos.symbol, "H1", 61), "H1", Date.now()).slice(-60);
        lastAtr = last(atr(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14)) ?? null;
      } catch {
        lastAtr = null;
      }
    }
    const managed = calculateManagedStop({
      direction: isBuy ? "buy" : "sell",
      entryPrice: entry,
      originalStopLoss: trade.stopLoss,
      currentStopLoss: currentSl,
      executablePrice: price,
      atr: lastAtr,
      trailingEnabled,
      breakEvenDone: isBuy ? currentSl >= entry : currentSl <= entry,
    });
    let newSl = managed.stopLoss;
    if (newSl === currentSl) continue;
    // Final ratchet guard: never move a stop against the trade.
    if (isBuy ? newSl <= currentSl : newSl >= currentSl) continue;

    const profitR = (isBuy ? price - entry : entry - price) / r;
    const reason = managed.trailingActivated
      ? `ATR trail at +${profitR.toFixed(1)}R`
      : `break-even at +${profitR.toFixed(1)}R`;

    const digits = price < 100 ? 5 : 2;
    newSl = Number(newSl.toFixed(digits));
    try {
      const result = await mt5.modifyPosition(pos.ticket, { sl: newSl }, "system:position-manager");
      if (result.ok) {
        await audit({
          actor: "system:position-manager", userId: trade.userId, category: "trade", action: "stop_ratcheted",
          detail: { tradeId: trade.id, ticket: pos.ticket, symbol: pos.symbol, from: currentSl, to: newSl, reason },
        });
        await notify(trade.userId, "trade_opened", `Stop moved: ${pos.symbol}`,
          `${reason} — SL ${currentSl} → ${newSl} (ticket ${pos.ticket})`);
      }
    } catch (err) {
      await logError("position-manager", "modify failed", { ticket: pos.ticket, error: String(err) });
    }
  }
}

/**
 * Adopt positions the bot didn't open so it can manage them like its own.
 * We record the broker's open price and current stop ONCE as the immutable R
 * reference (the management loop never rewrites Trade.stopLoss), keeping
 * break-even / trailing stable. Positions without a stop are still adopted but
 * can't be break-even/trail-managed until one exists — we flag that.
 */
async function adoptExternalPositions(positions: Position[]) {
  const user = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  if (!user) return [];
  const accountId = await currentAccountId(user.id);

  const created = [];
  for (const p of positions) {
    const trade = await prisma.trade.create({
      data: {
        userId: user.id, accountId, symbol: p.symbol,
        direction: p.type === "buy" ? "BUY" : "SELL",
        lots: p.volume, entryPrice: p.price_open,
        stopLoss: p.sl ?? null, takeProfit: p.tp ?? null,
        status: "EXECUTED", mode: "MANUAL", mt5Ticket: p.ticket,
        openedAt: p.time ? new Date(p.time) : new Date(),
        explanation: { adopted: true, source: "external", note: "Opened outside the bot; adopted for management." },
      },
      include: { strategy: true },
    });
    await audit({
      actor: "system:position-manager", userId: user.id, category: "trade", action: "position_adopted",
      detail: { tradeId: trade.id, ticket: p.ticket, symbol: p.symbol, type: p.type, volume: p.volume, hasStop: p.sl != null },
    });
    await notify(user.id, "trade_opened", `Now managing ${p.symbol}`,
      `Adopted an externally-opened ${p.type.toUpperCase()} ${p.symbol} (${p.volume} lots). Break-even & trailing will apply` +
      `${p.sl == null ? " — but it has NO stop-loss, so set one for break-even/trailing to engage." : "."}`);
    created.push(trade);
  }
  return created;
}
