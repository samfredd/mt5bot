import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { audit, logError } from "../lib/audit.js";
import { getBotState } from "../modules/system/state.js";
import { refreshCalendar } from "../modules/news/service.js";
import { refreshHeadlines } from "../modules/news/headlines.js";
import { evaluateAndMaybeTrade, enforceEquityGuardian, retryEmergencyFlatten } from "../modules/trading/service.js";
import { managePositions } from "../modules/trading/manager.js";
import { expirePendingTradeApprovals, syncClosedTrades } from "../modules/trading/reconciliation.js";
import { getScannerConfig, runScanner } from "../modules/trading/scanner.js";
import { broadcast } from "../modules/ws/hub.js";
import { withSchedulerLease } from "./scheduler-lease.js";
import { reconcilePaperTrades } from "../modules/trading/paper.js";
import { positionsForNewsFlatten } from "../modules/news/flatten.js";
import { mt5 } from "../modules/mt5/client.js";
import { notify } from "../modules/notifications/service.js";
import { publishFloatingPnl } from "../modules/trading/floating-pnl.js";
import { enforceDayTradingExit, dayTradingBlocksEntry } from "../modules/trading/day-trading.js";
import { expandStrategySymbols } from "../modules/strategy/symbols.js";
import { startScalpingWorker, stopScalpingWorker } from "../modules/scalping/scalping.worker.js";
import { getOperationalConfig } from "../modules/system/operational-config.js";
import { backfillTradeMemories } from "../modules/memory/service.js";
import { intelligenceMaintenance, runDueSources } from "../modules/intelligence/service.js";
import { generateResearchBrief } from "../modules/intelligence/briefs.js";
import { ensureSourceCatalogue } from "../modules/intelligence/catalogue.js";

let analysisTimer: NodeJS.Timeout | null = null;
let protectionTimer: NodeJS.Timeout | null = null;
let newsTimer: NodeJS.Timeout | null = null;
let labTimer: NodeJS.Timeout | null = null;
let pnlTimer: NodeJS.Timeout | null = null;
let intelligenceTimer: NodeJS.Timeout | null = null;
let intelligenceMaintenanceTimer: NodeJS.Timeout | null = null;
let analysisRunning = false;
let protectionRunning = false;
let lastScanAt = 0;
let workersRunning = false;

/**
 * Main loop: every minute, when the bot is running, evaluate every enabled
 * strategy against every one of its symbols. The pipeline inside
 * evaluateAndMaybeTrade enforces all gates; this loop just schedules work.
 */
async function protectiveTick() {
  const state = await getBotState();
  const operationalConfig = await getOperationalConfig();
  broadcast("bot_state", state);
  await expirePendingTradeApprovals().catch((err) =>
    logError("scheduler", "approval expiry cleanup failed", { error: String(err) }),
  );
  await retryEmergencyFlatten().catch((err) =>
    logError("scheduler", "emergency flatten retry failed", { error: String(err) }),
  );
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
  await backfillTradeMemories(undefined, operationalConfig.tradingMemoryBackfillBatchSize).catch((err) =>
    logError("scheduler", "trading-memory learning failed", { error: String(err) }),
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
  if (analysisRunning) return;
  analysisRunning = true;
  try {
    const { strategyAnalysisIntervalMs } = await getOperationalConfig();
    await withSchedulerLease("analysis-new-trades", strategyAnalysisIntervalMs * 2, newTradeTick);
  } catch (err) {
    await logError("scheduler", "analysis tick failed", { error: String(err) });
  } finally {
    analysisRunning = false;
  }
}

async function protectionTickIndependent() {
  if (protectionRunning) return;
  protectionRunning = true;
  try { await protectiveTick(); }
  catch (err) { await logError("scheduler", "independent protection tick failed", { error: String(err) }); }
  finally { protectionRunning = false; }
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

async function scheduleNewsRefresh(): Promise<void> {
  if (!workersRunning) return;
  const { newsRefreshMinutes } = await getOperationalConfig();
  await withSchedulerLease("news", newsRefreshMinutes * 120_000, async () => {
    await Promise.all([refreshCalendar(), refreshHeadlines()]);
  });
  newsTimer = setTimeout(() => {
    void scheduleNewsRefresh().catch((err) => logError("scheduler", "news tick failed", { error: String(err) }));
  }, newsRefreshMinutes * 60_000);
}

async function schedulePnl(): Promise<void> {
  if (!workersRunning) return;
  const { floatingPnlIntervalMs } = await getOperationalConfig();
  pnlTimer = setTimeout(async () => {
    await publishFloatingPnl().catch((err) => logError("scheduler", "floating P/L broadcast failed", { error: String(err) }));
    void schedulePnl();
  }, floatingPnlIntervalMs);
}

async function scheduleAnalysis(): Promise<void> {
  if (!workersRunning) return;
  const { strategyAnalysisIntervalMs } = await getOperationalConfig();
  analysisTimer = setTimeout(async () => {
    await analysisTick();
    void scheduleAnalysis();
  }, strategyAnalysisIntervalMs);
}

async function scheduleProtection(): Promise<void> {
  if (!workersRunning) return;
  const { protectionIntervalMs } = await getOperationalConfig();
  protectionTimer = setTimeout(async () => {
    await protectionTickIndependent();
    void scheduleProtection();
  }, protectionIntervalMs);
}

async function scheduleLab(): Promise<void> {
  if (!workersRunning) return;
  const { strategyLabIntervalHours } = await getOperationalConfig();
  const intervalMs = strategyLabIntervalHours * 3_600_000;
  labTimer = setTimeout(async () => {
    await withSchedulerLease("strategy-lab", intervalMs / 2, labTick);
    void scheduleLab();
  }, intervalMs);
}

async function scheduleIntelligence(): Promise<void> {
  if (!workersRunning) return;
  const { intelligencePollIntervalMin } = await getOperationalConfig();
  const intervalMs = intelligencePollIntervalMin * 60_000;
  intelligenceTimer = setTimeout(async () => {
    await withSchedulerLease("market-intelligence", Math.max(1_000, intervalMs * 0.8), () => runDueSources())
      .catch((err) => logError("scheduler", "intelligence ingestion failed", { error: String(err) }));
    void scheduleIntelligence();
  }, intervalMs);
}

async function scheduleIntelligenceMaintenance(): Promise<void> {
  if (!workersRunning) return;
  const { intelligenceMaintenanceIntervalHours } = await getOperationalConfig();
  const intervalMs = intelligenceMaintenanceIntervalHours * 3_600_000;
  intelligenceMaintenanceTimer = setTimeout(async () => {
    await withSchedulerLease("intelligence-maintenance", Math.max(1_000, intervalMs * 0.95), async () => {
      await intelligenceMaintenance();
      await generateResearchBrief("DAILY");
      if (new Date().getUTCDay() === 0) await generateResearchBrief("WEEKLY");
    }).catch((err) => logError("scheduler", "intelligence maintenance failed", { error: String(err) }));
    void scheduleIntelligenceMaintenance();
  }, intervalMs);
}

export function startWorkers() {
  if (workersRunning) return;
  workersRunning = true;
  void schedulePnl();
  void scheduleAnalysis();
  void scheduleProtection();
  void scheduleLab();
  void scheduleNewsRefresh().catch((err) => logError("scheduler", "initial news refresh failed", { error: String(err) }));
  void publishFloatingPnl().catch((err) => logError("scheduler", "initial floating P/L broadcast failed", { error: String(err) }));
  void protectionTickIndependent();
  void ensureSourceCatalogue().then(() => runDueSources()).catch((err) => logError("scheduler", "initial intelligence ingestion failed", { error: String(err) }));
  void scheduleIntelligence();
  void scheduleIntelligenceMaintenance();
  startScalpingWorker();
  logger.info("background workers started with database-managed cadences");
}

export function stopWorkers() {
  workersRunning = false;
  if (analysisTimer) clearTimeout(analysisTimer);
  if (protectionTimer) clearTimeout(protectionTimer);
  if (newsTimer) clearTimeout(newsTimer);
  if (labTimer) clearTimeout(labTimer);
  if (pnlTimer) clearTimeout(pnlTimer);
  if (intelligenceTimer) clearTimeout(intelligenceTimer);
  if (intelligenceMaintenanceTimer) clearTimeout(intelligenceMaintenanceTimer);
  stopScalpingWorker();
}
