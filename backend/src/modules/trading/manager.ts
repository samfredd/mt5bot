import { prisma } from "../../lib/prisma.js";
import { audit, logError } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { atr, last } from "../analysis/indicators.js";
import { notify } from "../notifications/service.js";

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
  const openTrades = await prisma.trade.findMany({
    where: { status: "EXECUTED", mt5Ticket: { not: null } },
    include: { strategy: true },
  });
  if (!openTrades.length) return;

  let positions;
  try {
    positions = await mt5.positions();
  } catch {
    return; // bridge unreachable — nothing to manage safely
  }
  const byTicket = new Map(positions.map((p) => [p.ticket, p]));

  for (const trade of openTrades) {
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
    const profitDist = isBuy ? price - entry : entry - price;
    const profitR = profitDist / r;
    const currentSl = pos.sl ?? trade.stopLoss;

    let newSl: number | null = null;
    let reason = "";

    // 1. Break-even at +1R
    const beLevel = isBuy ? entry + 0.1 * r : entry - 0.1 * r;
    const beNeeded = isBuy ? currentSl < entry : currentSl > entry;
    if (profitR >= 1 && beNeeded) {
      newSl = beLevel;
      reason = `break-even at +${profitR.toFixed(1)}R`;
    }

    // 2. ATR trail beyond +1.5R (when the strategy enables trailing)
    const trailingEnabled = (trade.strategy?.config as { exit?: { trailingStop?: boolean } })?.exit?.trailingStop ?? true;
    if (trailingEnabled && profitR >= 1.5) {
      try {
        const candles = await mt5.candles(pos.symbol, "H1", 60);
        const lastAtr = last(atr(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14));
        if (lastAtr && lastAtr > 0) {
          const trailLevel = isBuy ? price - lastAtr : price + lastAtr;
          const improves = isBuy ? trailLevel > Math.max(currentSl, newSl ?? -Infinity) : trailLevel < Math.min(currentSl, newSl ?? Infinity);
          if (improves) {
            newSl = trailLevel;
            reason = `ATR trail at +${profitR.toFixed(1)}R`;
          }
        }
      } catch {
        /* candle fetch failed — keep whatever we have */
      }
    }

    if (newSl === null) continue;
    // Final ratchet guard: never move a stop against the trade.
    if (isBuy ? newSl <= currentSl : newSl >= currentSl) continue;

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
