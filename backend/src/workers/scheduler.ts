import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logError } from "../lib/audit.js";
import { config } from "../config.js";
import { getBotState } from "../modules/system/state.js";
import { refreshCalendar } from "../modules/news/service.js";
import { refreshHeadlines } from "../modules/news/headlines.js";
import { evaluateAndMaybeTrade } from "../modules/trading/service.js";
import { managePositions } from "../modules/trading/manager.js";
import { getScannerConfig, runScanner } from "../modules/trading/scanner.js";
import { mt5 } from "../modules/mt5/client.js";
import { notify } from "../modules/notifications/service.js";
import { broadcast } from "../modules/ws/hub.js";

const ANALYSIS_INTERVAL_MS = 60_000;
let analysisTimer: NodeJS.Timeout | null = null;
let newsTimer: NodeJS.Timeout | null = null;
let running = false;
let lastScanAt = 0;

/**
 * Main loop: every minute, when the bot is running, evaluate every enabled
 * strategy against every one of its symbols. The pipeline inside
 * evaluateAndMaybeTrade enforces all gates; this loop just schedules work.
 */
async function analysisTick() {
  if (running) return; // never overlap ticks
  running = true;
  try {
    const state = await getBotState();
    broadcast("bot_state", state);

    // Protect open positions (break-even / trailing) even while paused —
    // only a true emergency stop skips this (positions get closed there).
    if (!state.emergencyStop) {
      await managePositions().catch((err) =>
        logError("scheduler", "position management failed", { error: String(err) }),
      );
    }

    if (state.status !== "running" || state.emergencyStop) return;

    // Autonomous scanner on its own cadence (independent of strategies).
    const scannerCfg = await getScannerConfig();
    if (scannerCfg.enabled && Date.now() - lastScanAt >= scannerCfg.intervalMin * 60_000) {
      lastScanAt = Date.now();
      await runScanner("schedule").catch((err) =>
        logError("scheduler", "scanner run failed", { error: String(err) }),
      );
    }

    const strategies = await prisma.strategy.findMany({ where: { enabled: true }, include: { user: true } });
    for (const strategy of strategies) {
      const cfg = strategy.config as { symbols?: string[] };
      for (const symbol of cfg.symbols ?? []) {
        try {
          await evaluateAndMaybeTrade(strategy.user, strategy, symbol);
        } catch (err) {
          await logError("scheduler", `evaluation failed for ${symbol}`, { strategy: strategy.name, error: String(err) });
        }
      }
    }

    await syncClosedTrades();
  } catch (err) {
    await logError("scheduler", "analysis tick failed", { error: String(err) });
  } finally {
    running = false;
  }
}

/**
 * Reconcile DB trades against the broker: detect SL/TP closures AND pull the
 * realized profit from deal history. Analytics and the loss-streak circuit
 * breaker both depend on accurate per-trade profit.
 */
async function syncClosedTrades() {
  const open = await prisma.trade.findMany({ where: { status: "EXECUTED", mt5Ticket: { not: null } } });
  const needBackfill = await prisma.trade.findMany({
    where: { status: "CLOSED", profit: null, mt5Ticket: { not: null }, closedAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
  });
  if (!open.length && !needBackfill.length) return;

  const positions = await mt5.positions();
  const liveTickets = new Set(positions.map((p) => p.ticket));
  const justClosed = open.filter((t) => !liveTickets.has(t.mt5Ticket!));
  if (!justClosed.length && !needBackfill.length) return;

  // Deal history: real MT5 deals carry position_id; the mock uses the
  // position ticket directly. Net profit = sum of the position's deals.
  let deals: { ticket?: string; position_id?: string; profit?: number }[] = [];
  try {
    deals = (await mt5.history(7)) as typeof deals;
  } catch {
    /* history unavailable — close without profit; backfill will retry */
  }
  const profitFor = (ticket: string): number | null => {
    const matched = deals.filter((d) => (d.position_id ?? d.ticket) === ticket);
    return matched.length ? Number(matched.reduce((a, d) => a + (d.profit ?? 0), 0).toFixed(2)) : null;
  };

  for (const trade of justClosed) {
    const profit = profitFor(trade.mt5Ticket!);
    const closed = await prisma.trade.update({
      where: { id: trade.id },
      data: { status: "CLOSED", closedAt: new Date(), profit },
    });
    await notify(trade.userId, "trade_closed", `Trade closed: ${trade.symbol}`,
      `Ticket ${trade.mt5Ticket} closed (SL/TP hit or closed at broker).${profit !== null ? ` Realized P/L: ${profit.toFixed(2)}` : ""}`);
    broadcast("trade", { tradeId: closed.id, status: "CLOSED" });
  }

  for (const trade of needBackfill) {
    const profit = profitFor(trade.mt5Ticket!);
    if (profit !== null) {
      await prisma.trade.update({ where: { id: trade.id }, data: { profit } });
    }
  }
}

export function startWorkers() {
  analysisTimer = setInterval(analysisTick, ANALYSIS_INTERVAL_MS);
  newsTimer = setInterval(() => {
    void refreshCalendar();
    void refreshHeadlines();
  }, config.NEWS_REFRESH_MINUTES * 60_000);
  void refreshCalendar();
  void refreshHeadlines();
  logger.info("background workers started (analysis + position mgmt + calendar + headlines)");
}

export function stopWorkers() {
  if (analysisTimer) clearInterval(analysisTimer);
  if (newsTimer) clearInterval(newsTimer);
}
