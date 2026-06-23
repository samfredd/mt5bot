import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { audit, logError } from "../lib/audit.js";
import { config } from "../config.js";
import { getBotState } from "../modules/system/state.js";
import { refreshCalendar } from "../modules/news/service.js";
import { refreshHeadlines } from "../modules/news/headlines.js";
import { evaluateAndMaybeTrade, enforceEquityGuardian } from "../modules/trading/service.js";
import { managePositions } from "../modules/trading/manager.js";
import { syncClosedTrades } from "../modules/trading/reconciliation.js";
import { getScannerConfig, runScanner } from "../modules/trading/scanner.js";
import { broadcast } from "../modules/ws/hub.js";
import { withSchedulerLease } from "./scheduler-lease.js";
import { reconcilePaperTrades } from "../modules/trading/paper.js";
import { positionsForNewsFlatten } from "../modules/news/flatten.js";
import { mt5 } from "../modules/mt5/client.js";
import { notify } from "../modules/notifications/service.js";
import { publishFloatingPnl } from "../modules/trading/floating-pnl.js";
import { runCoordinatedAnalysisCycle } from "./scheduler-cycle.js";
import { enforceDayTradingExit, dayTradingBlocksEntry } from "../modules/trading/day-trading.js";
import { expandStrategySymbols } from "../modules/strategy/symbols.js";
import { startScalpingWorker, stopScalpingWorker } from "../modules/scalping/scalping.worker.js";

const ANALYSIS_INTERVAL_MS = 60_000;
const LAB_INTERVAL_MS = 7 * 24 * 60 * 60_000; // weekly
let analysisTimer: NodeJS.Timeout | null = null;
let newsTimer: NodeJS.Timeout | null = null;
let labTimer: NodeJS.Timeout | null = null;
let pnlTimer: NodeJS.Timeout | null = null;
let running = false;
let lastScanAt = 0;

/**
 * Main loop: every minute, when the bot is running, evaluate every enabled
 * strategy against every one of its symbols. The pipeline inside
 * evaluateAndMaybeTrade enforces all gates; this loop just schedules work.
 */
async function protectiveTick() {
  const state = await getBotState();
  broadcast("bot_state", state);
  await reconcilePaperTrades().catch((err) =>
    logError("scheduler", "paper-trade reconciliation failed", { error: String(err) }),
  );

  // Protection must not depend on Redis lease acquisition. When Redis is
  // unavailable, new trades fail closed while direct MT5 protection continues.
  if (!state.emergencyStop) {
      const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
      const settings = admin ? await prisma.riskSettings.findUnique({ where: { userId: admin.id } }) : null;
      if (admin && settings?.autoFlattenNewsEnabled) {
        const now = new Date();
        const [positions, events] = await Promise.all([
          mt5.positions(),
          prisma.newsEvent.findMany({
            where: { eventTime: { gte: now, lte: new Date(now.getTime() + settings.autoFlattenLeadMin * 60_000) } },
          }),
        ]);
        const selected = positionsForNewsFlatten({
          enabled: settings.autoFlattenNewsEnabled,
          leadMinutes: settings.autoFlattenLeadMin,
          minimumImpact: settings.autoFlattenMinimumImpact,
          symbols: settings.autoFlattenSymbols as string[],
          events,
          positions,
          now,
        });
        const closed: string[] = [];
        for (const position of selected) {
          const result = await mt5.closePosition(position.ticket, "system:news-flatten");
          if (result.ok) closed.push(position.ticket);
        }
        if (closed.length) {
          await audit({
            actor: "system:news-flatten",
            userId: admin.id,
            category: "news",
            action: "positions_flattened_before_news",
            detail: { tickets: closed, leadMinutes: settings.autoFlattenLeadMin },
          });
          await notify(admin.id, "trade_closed", "Positions flattened before high-impact news", `${closed.length} scoped position(s) closed.`);
        }
      }
      await managePositions().catch((err) =>
        logError("scheduler", "position management failed", { error: String(err) }),
      );
      // Capital-protection guardian: may flatten + pause if equity breaches
      // the floor. Runs before new-trade evaluation so a tripped guardian
      // stops this tick from opening anything.
      await enforceEquityGuardian().catch((err) =>
        logError("scheduler", "equity guardian failed", { error: String(err) }),
      );
      // Day-trading (intraday-only): flatten everything past the daily cutoff.
      await enforceDayTradingExit().catch((err) =>
        logError("scheduler", "day-trading flatten failed", { error: String(err) }),
      );
  }
  await syncClosedTrades().catch((err) =>
    logError("scheduler", "broker reconciliation failed", { error: String(err) }),
  );
}

async function newTradeTick() {
  const state = await getBotState();
  if (state.status !== "running" || state.emergencyStop) return;
  // Day-trading: stop opening new positions past the daily cutoff.
  if (await dayTradingBlocksEntry()) return;
  const scannerCfg = await getScannerConfig();
  if (scannerCfg.enabled && Date.now() - lastScanAt >= scannerCfg.intervalMin * 60_000) {
    lastScanAt = Date.now();
    await runScanner("schedule").catch((err) =>
      logError("scheduler", "scanner run failed", { error: String(err) }),
    );
  }
  const strategies = await prisma.strategy.findMany({ where: { enabled: true }, include: { user: true } });
  // Resolve the broker FX universe once so ALL_FX strategies don't refetch per strategy.
  const available = await mt5.symbols().catch(() => [] as string[]);
  for (const strategy of strategies) {
    const cfg = strategy.config as { symbols?: string[] };
    for (const symbol of expandStrategySymbols(cfg.symbols ?? [], available)) {
      try {
        await evaluateAndMaybeTrade(strategy.user, strategy, symbol);
      } catch (err) {
        await logError("scheduler", `evaluation failed for ${symbol}`, { strategy: strategy.name, error: String(err) });
      }
    }
  }
}

async function analysisTick() {
  if (running) return;
  running = true;
  try {
    await runCoordinatedAnalysisCycle({
      protect: protectiveTick,
      newTradeWork: newTradeTick,
      withLease: (work) => withSchedulerLease("analysis-new-trades", ANALYSIS_INTERVAL_MS * 2, work),
    });
  } catch (err) {
    await logError("scheduler", "analysis tick failed", { error: String(err) });
  } finally {
    running = false;
  }
}

/** Weekly AI Strategy Lab sweep — runs under the admin user; survivors stay disabled. */
async function labTick() {
  try {
    const { runStrategyLab } = await import("../modules/strategy/lab.js");
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
    if (!admin) return;
    await runStrategyLab("schedule", admin.id);
  } catch (err) {
    await logError("scheduler", "strategy lab run failed", { error: String(err) });
  }
}

export function startWorkers() {
  pnlTimer = setInterval(() => {
    void publishFloatingPnl().catch((err) => logError("scheduler", "floating P/L broadcast failed", { error: String(err) }));
  }, 2_000);
  analysisTimer = setInterval(() => {
    void analysisTick();
  }, ANALYSIS_INTERVAL_MS);
  newsTimer = setInterval(() => {
    void withSchedulerLease("news", config.NEWS_REFRESH_MINUTES * 120_000, async () => {
      await Promise.all([refreshCalendar(), refreshHeadlines()]);
    });
  }, config.NEWS_REFRESH_MINUTES * 60_000);
  labTimer = setInterval(() => {
    void withSchedulerLease("strategy-lab", LAB_INTERVAL_MS / 2, labTick);
  }, LAB_INTERVAL_MS);
  void withSchedulerLease("news", config.NEWS_REFRESH_MINUTES * 120_000, async () => {
    await Promise.all([refreshCalendar(), refreshHeadlines()]);
  });
  void publishFloatingPnl().catch((err) => logError("scheduler", "initial floating P/L broadcast failed", { error: String(err) }));
  // Scalping runs on its own 1-second cadence, fully independent of the
  // 60-second strategy/scanner loop above.
  startScalpingWorker();
  logger.info("background workers started (analysis + position mgmt + calendar + headlines + weekly strategy lab + scalping)");
}

export function stopWorkers() {
  if (analysisTimer) clearInterval(analysisTimer);
  if (newsTimer) clearInterval(newsTimer);
  if (labTimer) clearInterval(labTimer);
  if (pnlTimer) clearInterval(pnlTimer);
  stopScalpingWorker();
}
