import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { notify } from "../notifications/service.js";
import { broadcast } from "../ws/hub.js";

/**
 * Day-trading (intraday-only) mode. Orthogonal to the trading mode
 * (MANUAL/SEMI_AUTO/AUTO/COPY): when enabled, the bot stops opening new
 * positions at a daily UTC cutoff and FLATTENS everything that's still open,
 * so nothing is ever held overnight (no swap/gap risk). Configuration lives in
 * SystemSetting so it touches no churning shared modules.
 */

export interface DayTradingConfig {
  enabled: boolean;
  /** Daily close cutoff, UTC. Past this, new entries stop and open trades are flattened. */
  closeHourUtc: number;
  closeMinuteUtc: number;
}

const DEFAULTS: DayTradingConfig = { enabled: false, closeHourUtc: 20, closeMinuteUtc: 45 };
const KEY = "day_trading";

export async function getDayTradingConfig(): Promise<DayTradingConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  const stored = (row?.value as Partial<DayTradingConfig> | undefined) ?? {};
  return { ...DEFAULTS, ...stored };
}

export async function setDayTradingConfig(patch: Partial<DayTradingConfig>, actor: string): Promise<DayTradingConfig> {
  const next: DayTradingConfig = { ...(await getDayTradingConfig()), ...patch };
  next.closeHourUtc = Math.min(23, Math.max(0, Math.floor(next.closeHourUtc)));
  next.closeMinuteUtc = Math.min(59, Math.max(0, Math.floor(next.closeMinuteUtc)));
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as object },
    update: { value: next as object },
  });
  await audit({ actor, category: "system", action: "day_trading_config_updated", detail: { patch, next } });
  return next;
}

/** Pure: is `now` at/after the daily close cutoff (UTC)? */
export function isPastDailyClose(now: Date, closeHourUtc: number, closeMinuteUtc: number): boolean {
  return now.getUTCHours() * 60 + now.getUTCMinutes() >= closeHourUtc * 60 + closeMinuteUtc;
}

/** Pure: in day-trading mode, new entries are blocked at/after the cutoff. */
export function dayTradingBlocksEntryAt(config: DayTradingConfig, now: Date): boolean {
  return config.enabled && isPastDailyClose(now, config.closeHourUtc, config.closeMinuteUtc);
}

/** Whether new-trade evaluation should be skipped right now (day-trading cutoff). */
export async function dayTradingBlocksEntry(now = new Date()): Promise<boolean> {
  return dayTradingBlocksEntryAt(await getDayTradingConfig(), now);
}

/**
 * Intraday-only enforcement: once past the daily cutoff, flatten every open
 * position so nothing is held overnight. Idempotent — a no-op when nothing is
 * open (which it will be after the first flatten, since entries are blocked).
 * Closes only positions owned by this application. Manual positions and
 * positions from other EAs must never be mutated by an automated cutoff.
 */
export async function enforceDayTradingExit(now = new Date()): Promise<string[]> {
  const cfg = await getDayTradingConfig();
  if (!cfg.enabled || !isPastDailyClose(now, cfg.closeHourUtc, cfg.closeMinuteUtc)) return [];

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  if (!admin) return [];
  const positions = await mt5.positions().catch(() => []);
  if (!positions.length) return [];
  const tracked = await prisma.trade.findMany({
    where: { userId: admin.id, status: { in: ["EXECUTED", "PARTIALLY_FILLED"] }, mt5Ticket: { not: null } },
    select: { mt5Ticket: true },
  });
  const trackedTickets = new Set(tracked.map((trade) => trade.mt5Ticket));
  const ownedPositions = positions.filter((position) =>
    trackedTickets.has(position.ticket) || position.magic === 770077 || position.comment?.startsWith("mt5bot:"),
  );
  const closed: string[] = [];
  for (const position of ownedPositions) {
    const result = await mt5.closePosition(position.ticket, "system:day-trading-close").catch(() => ({ ok: false as const }));
    if (result.ok) closed.push(position.ticket);
  }
  if (closed.length) {
    await audit({
      actor: "system:day-trading-close", userId: admin.id, category: "trade", action: "day_trading_flatten",
      detail: { closed, cutoffUtc: `${String(cfg.closeHourUtc).padStart(2, "0")}:${String(cfg.closeMinuteUtc).padStart(2, "0")}` },
    });
    await notify(admin.id, "trade_closed", "Day-trading: positions flattened",
      `Intraday-only mode closed ${closed.length} position(s) at the daily cutoff — nothing held overnight.`);
    broadcast("trade", { dayTradingFlatten: true, closed });
  }
  return closed;
}
