import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { StrategyConfigSchema } from "./types.js";
import { PRESET_STRATEGIES } from "./presets.js";
import { runStrategyLab, lastLabRun } from "./lab.js";
import { listValidationRuns } from "./validation-runs.js";

export async function strategyRoutes(app: FastifyInstance) {
  // --- AI Strategy Lab: generate → auto-validate → DISABLED candidates ---
  app.get("/api/strategy-lab/last", { preHandler: [app.authenticate] }, async () => {
    const { webSearchConfigured } = await import("../web/search.js");
    const last = (await lastLabRun()) ?? { proposals: [], survivors: 0, ranAt: null };
    // Always reflect CURRENT web-search config (a stored run may predate it).
    return { ...last, webSearchEnabled: webSearchConfigured() };
  });

  app.post("/api/strategy-lab/run", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    return runStrategyLab("manual", req.user.id);
  });

  app.get("/api/strategies", { preHandler: [app.authenticate] }, async (req) => {
    return prisma.strategy.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "asc" } });
  });

  app.get("/api/strategies/validation-runs", { preHandler: [app.authenticate] }, async (req, reply) => {
    const query = z.object({
      strategyId: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      includeInfrastructureErrors: z.enum(["true", "false"]).optional(),
    }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid validation-run query", issues: query.error.issues });
    return listValidationRuns({
      userId: req.user.id,
      strategyId: query.data.strategyId,
      limit: query.data.limit,
      includeInfrastructureErrors: query.data.includeInfrastructureErrors === "true",
    });
  });

  app.get("/api/strategies/presets", { preHandler: [app.authenticate] }, async () => PRESET_STRATEGIES);

  app.post("/api/strategies", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1), type: z.string().min(1), config: StrategyConfigSchema }).safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return reply.code(400).send({
        error: `invalid strategy — ${issue?.path.join(".") || "config"}: ${issue?.message ?? "unknown error"}`,
        issues: body.error.issues,
      });
    }
    const strategy = await prisma.strategy.create({
      data: { userId: req.user.id, name: body.data.name, type: body.data.type, config: body.data.config as object },
    });
    await audit({ actor: req.user.email, userId: req.user.id, category: "strategy", action: "strategy_created", detail: { id: strategy.id, name: strategy.name } });
    return strategy;
  });

  app.put("/api/strategies/:id", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      name: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      config: StrategyConfigSchema.optional(),
    }).safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return reply.code(400).send({
        error: `invalid update — ${issue?.path.join(".") || "config"}: ${issue?.message ?? "unknown error"}`,
        issues: body.error.issues,
      });
    }
    const existing = await prisma.strategy.findFirst({ where: { id, userId: req.user.id } });
    if (!existing) return reply.code(404).send({ error: "not found" });
    const strategy = await prisma.strategy.update({
      where: { id },
      data: { ...body.data, config: body.data.config ? (body.data.config as object) : undefined },
    });
    await audit({ actor: req.user.email, userId: req.user.id, category: "strategy", action: "strategy_updated", detail: { id, changes: body.data } });
    return strategy;
  });

  app.delete("/api/strategies/:id", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.strategy.findFirst({ where: { id, userId: req.user.id } });
    if (!existing) return reply.code(404).send({ error: "not found" });
    await prisma.strategy.delete({ where: { id } });
    await audit({ actor: req.user.email, userId: req.user.id, category: "strategy", action: "strategy_deleted", detail: { id } });
    return { ok: true };
  });

  // --- Risk settings ---
  const RiskUpdate = z.object({
    maxRiskPerTradePct: z.number().positive().max(10).optional(),
    maxDailyLossPct: z.number().positive().max(50).optional(),
    maxWeeklyLossPct: z.number().positive().max(50).optional(),
    maxDrawdownPct: z.number().positive().max(80).optional(),
    maxOpenTrades: z.number().int().positive().max(100).optional(),
    maxTradesPerSymbol: z.number().int().positive().max(20).optional(),
    maxTradesPerDay: z.number().int().positive().max(100).optional(),
    maxLotSize: z.number().positive().max(100).optional(),
    minRiskReward: z.number().positive().max(10).optional(),
    maxConsecutiveLosses: z.number().int().positive().max(20).optional(),
    requireStopLoss: z.boolean().optional(),
    requireTakeProfit: z.boolean().optional(),
    maxSpreadPoints: z.number().positive().optional(),
    maxAtrVolatilityPct: z.number().positive().optional(),
    newsRiskLimit: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
    pauseBeforeNewsMin: z.number().int().min(0).optional(),
    pauseAfterNewsMin: z.number().int().min(0).optional(),
    allowNewsTrading: z.boolean().optional(),
    allowedSessions: z.array(z.string()).optional(),
    equityProtectionPct: z.number().min(0).max(100).optional(),
    copyExposureLimitPct: z.number().positive().max(100).optional(),
    maxDailyCopiedTrades: z.number().int().positive().optional(),
    maxCurrencyExposurePct: z.number().positive().max(5000).optional(),
    maxCorrelatedExposurePct: z.number().positive().max(5000).optional(),
    autoFlattenNewsEnabled: z.boolean().optional(),
    autoFlattenLeadMin: z.number().int().min(0).max(240).optional(),
    autoFlattenMinimumImpact: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
    autoFlattenSymbols: z.array(z.string().min(3)).max(50).optional(),
  });

  app.get("/api/risk-settings", { preHandler: [app.authenticate] }, async (req) => {
    return prisma.riskSettings.upsert({
      where: { userId: req.user.id },
      create: { userId: req.user.id },
      update: {},
    });
  });

  app.put("/api/risk-settings", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = RiskUpdate.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid risk settings", issues: body.error.issues });
    // requireStopLoss can only be turned OFF by an admin — safety rule #4.
    if (body.data.requireStopLoss === false && req.user.role !== "ADMIN") {
      return reply.code(403).send({ error: "only an admin may disable the stop-loss requirement" });
    }
    const settings = await prisma.riskSettings.upsert({
      where: { userId: req.user.id },
      create: {
        userId: req.user.id,
        ...body.data,
        allowedSessions: body.data.allowedSessions as object | undefined,
        autoFlattenSymbols: body.data.autoFlattenSymbols as object | undefined,
      },
      update: {
        ...body.data,
        allowedSessions: body.data.allowedSessions as object | undefined,
        autoFlattenSymbols: body.data.autoFlattenSymbols as object | undefined,
      },
    });
    await audit({ actor: req.user.email, userId: req.user.id, category: "risk", action: "risk_settings_updated", detail: body.data });
    return settings;
  });
}
