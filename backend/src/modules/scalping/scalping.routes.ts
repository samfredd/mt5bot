import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { countConsecutiveLosses } from "../risk/engine.js";
import { z } from "zod";
import { ScalpingConfigPatchSchema, ScalpingRiskPatchSchema } from "./scalping.schema.js";
import {
  applyScalpingPreset, getScalpingConfig, getScalpingRisk, ScalpingRiskError,
  setScalpingConfig, setScalpingRisk, setScalpingStatus,
} from "./scalping.state.js";
import {
  listActiveScalps, listScalpingTrades, runScalpingCycleOnce, scalpingPerformance,
} from "./scalping.service.js";
import { getRecentScalpingDecisions, getScalpingPlans, refreshStalePlans } from "./scalping.ai.js";
import { currencies } from "./scalping.risk.js";
import { SCALPING_SOURCE } from "./scalping.types.js";
import { settingFailure, validationFailure } from "../../lib/validation.js";

const SCALP_FILTER = { explanation: { path: ["source"], equals: SCALPING_SOURCE } } as const;

function dayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Status-card summary for the dashboard page. */
async function buildSummary() {
  const [config, risk, perf, active] = await Promise.all([
    getScalpingConfig(), getScalpingRisk(), scalpingPerformance(), listActiveScalps(),
  ]);
  const closedToday = await prisma.trade.findMany({
    where: { ...SCALP_FILTER, status: "CLOSED", closedAt: { gte: dayStart() } },
    orderBy: { closedAt: "desc" },
    select: { profit: true },
    take: 50,
  });
  const lossStreak = countConsecutiveLosses(closedToday.map((t) => ({ profit: t.profit })));

  // Per-currency exposure across active scalps.
  const exposure: Record<string, number> = {};
  for (const a of active) {
    for (const ccy of currencies(a.symbol)) exposure[ccy] = (exposure[ccy] ?? 0) + 1;
  }

  return {
    status: config.status,
    enabled: config.enabled,
    openCount: active.length,
    maxOpen: risk.maxOpenTradesTotal,
    dailyPnl: perf.todayNet,
    lossStreak,
    aiFireControl: { enabled: config.useAiFireControl, mode: config.aiMode, minConfidence: config.minAiConfidence },
    activeSymbols: active.map((a) => a.symbol),
    currencyExposure: exposure,
    maxSharedCurrencyExposure: risk.maxSharedCurrencyExposure,
  };
}

export async function scalpingRoutes(app: FastifyInstance) {
  // --- Combined read for the page ---
  app.get("/api/scalping", { preHandler: [app.authenticate] }, async () => {
    const [config, risk, active, summary] = await Promise.all([
      getScalpingConfig(), getScalpingRisk(), listActiveScalps(), buildSummary(),
    ]);
    return { config, risk, status: config.status, active, summary };
  });

  app.put("/api/scalping", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const parsed = ScalpingConfigPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(validationFailure("Invalid scalping configuration", parsed.error));
    return setScalpingConfig(parsed.data, req.user.email);
  });

  // --- Scalping-specific risk settings (separate from global RiskSettings) ---
  app.get("/api/scalping/risk-settings", { preHandler: [app.authenticate] }, async () => getScalpingRisk());

  app.put("/api/scalping/risk-settings", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const parsed = ScalpingRiskPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(validationFailure("Invalid scalping risk settings", parsed.error));
    try {
      return await setScalpingRisk(parsed.data, req.user.email);
    } catch (err) {
      if (err instanceof ScalpingRiskError) return reply.code(400).send(settingFailure("scalping risk", err.message, "Lower Maximum open trades or Risk per trade, then save again."));
      throw err;
    }
  });

  // --- Apply a risk preset (low/medium/aggressive) over the current settings ---
  app.post("/api/scalping/preset", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const parsed = z.object({ preset: z.enum(["low", "medium", "aggressive"]) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(validationFailure("Invalid scalping preset", parsed.error));
    try {
      return await applyScalpingPreset(parsed.data.preset, req.user.email);
    } catch (err) {
      if (err instanceof ScalpingRiskError) return reply.code(400).send(settingFailure("scalping preset", err.message, "Choose a lower-risk preset or reduce total exposure."));
      throw err;
    }
  });

  // --- Run-state controls ---
  app.post("/api/scalping/start", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) =>
    setScalpingStatus("running", req.user.email));

  app.post("/api/scalping/pause", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) =>
    setScalpingStatus("paused", req.user.email));

  app.post("/api/scalping/stop", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) =>
    setScalpingStatus("stopped", req.user.email));

  // --- Manual single cycle for testing (refresh plans, then one manage+enter pass) ---
  app.post("/api/scalping/run-once", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    const config = await getScalpingConfig();
    const plans = await refreshStalePlans(config);
    const cycle = await runScalpingCycleOnce(`scalping:run-once:${req.user.email}`);
    return { ...cycle, plansRefreshed: plans.refreshed, planErrors: plans.errors };
  });

  // --- Reads scoped to scalping mode ---
  app.get("/api/scalping/trades", { preHandler: [app.authenticate] }, async (req) => {
    const { limit } = req.query as { limit?: string };
    return listScalpingTrades(Number(limit ?? 50));
  });

  app.get("/api/scalping/ai-decisions", { preHandler: [app.authenticate] }, async () => ({
    plans: getScalpingPlans(),
    recent: getRecentScalpingDecisions(25),
  }));

  app.get("/api/scalping/performance", { preHandler: [app.authenticate] }, async () => scalpingPerformance());
}
