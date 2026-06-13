import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { evaluateTrader, copySourceTrade, scoreTrader, type TraderMetrics } from "./service.js";
import { notify } from "../notifications/service.js";

const MetricsSchema = z.object({
  winRate: z.number().min(0).max(100),
  profitFactor: z.number().min(0),
  maxDrawdownPct: z.number().min(0).max(100),
  avgMonthlyReturnPct: z.number(),
  consistency: z.number().min(0).max(100),
  accountAgeMonths: z.number().min(0),
  tradesPerWeek: z.number().min(0),
  avgTradeDurationHours: z.number().min(0),
  maxLossStreak: z.number().int().min(0),
  recoveryBehavior: z.enum(["good", "average", "poor"]),
  symbolSpecialization: z.array(z.string()),
  lotBehavior: z.enum(["consistent", "variable", "martingale"]),
  newsBehavior: z.enum(["avoids", "trades_through"]),
});

const RulesSchema = z.object({
  lotMultiplier: z.number().positive().max(10).optional(),
  fixedLot: z.number().positive().optional(),
  maxRiskPerCopiedTradePct: z.number().positive().optional(),
  symbolsAllowed: z.array(z.string()).optional(),
  symbolsBlocked: z.array(z.string()).optional(),
  stopAfterDrawdownPct: z.number().positive().optional(),
  stopAfterLossStreak: z.number().int().positive().optional(),
  maxSourceLot: z.number().positive().optional(),
});

export async function copyRoutes(app: FastifyInstance) {
  app.get("/api/copy-traders", { preHandler: [app.authenticate] }, async (req) => {
    return prisma.copyTrader.findMany({
      where: { userId: req.user.id },
      include: { _count: { select: { copiedTrades: true } } },
    });
  });

  app.post("/api/copy-traders", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1), source: z.string().min(1), metrics: MetricsSchema, copyRules: RulesSchema.default({}) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid trader", issues: body.error.issues });
    const { score, flags } = scoreTrader(body.data.metrics as TraderMetrics);
    const trader = await prisma.copyTrader.create({
      data: {
        userId: req.user.id, name: body.data.name, source: body.data.source,
        metrics: body.data.metrics as object, copyRules: body.data.copyRules as object, riskScore: score,
      },
    });
    await audit({ actor: req.user.email, userId: req.user.id, category: "copy", action: "trader_added", detail: { id: trader.id, score, flags } });
    return { ...trader, flags };
  });

  /** AI + deterministic evaluation with full explanation. */
  app.post("/api/copy-traders/:id/evaluate", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const trader = await prisma.copyTrader.findFirst({ where: { id, userId: req.user.id } });
    if (!trader) return reply.code(404).send({ error: "not found" });
    return evaluateTrader(trader);
  });

  app.post("/api/copy-traders/:id/activate", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const trader = await prisma.copyTrader.findFirst({ where: { id, userId: req.user.id } });
    if (!trader) return reply.code(404).send({ error: "not found" });
    if (trader.riskScore >= 70) {
      return reply.code(422).send({ error: `risk score ${trader.riskScore}/100 is too high to copy — evaluate the trader for details` });
    }
    const updated = await prisma.copyTrader.update({ where: { id }, data: { active: true } });
    await notify(req.user.id, "copy_update", `Now copying ${trader.name}`, `Risk score ${trader.riskScore}/100.`);
    return updated;
  });

  app.post("/api/copy-traders/:id/deactivate", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const trader = await prisma.copyTrader.findFirst({ where: { id, userId: req.user.id } });
    if (!trader) return reply.code(404).send({ error: "not found" });
    const updated = await prisma.copyTrader.update({ where: { id }, data: { active: false } });
    await notify(req.user.id, "copy_update", `Stopped copying ${trader.name}`, "Deactivated by user.");
    return updated;
  });

  app.put("/api/copy-traders/:id/rules", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = RulesSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid rules", issues: body.error.issues });
    const trader = await prisma.copyTrader.findFirst({ where: { id, userId: req.user.id } });
    if (!trader) return reply.code(404).send({ error: "not found" });
    return prisma.copyTrader.update({ where: { id }, data: { copyRules: body.data as object } });
  });

  /**
   * Signal ingestion endpoint: external signal sources (or a poller) POST
   * source trades here; each one runs through copy rules + the risk engine.
   */
  app.post("/api/copy-traders/:id/signal", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      symbol: z.string().min(3),
      direction: z.enum(["buy", "sell"]),
      // Optional: human signals often omit size — we size from risk settings.
      lots: z.number().positive().optional(),
      sl: z.number().positive().optional(),
      tp: z.number().positive().optional(),
      ref: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid signal", issues: body.error.issues });
    const trader = await prisma.copyTrader.findFirst({ where: { id, userId: req.user.id } });
    if (!trader) return reply.code(404).send({ error: "not found" });
    if (!trader.active) return reply.code(409).send({ error: "trader is not active" });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const trade = await copySourceTrade(user!, trader, body.data);
    return trade ?? { ok: false, message: "copy rejected — see audit log for the reason" };
  });

  app.get("/api/copied-trades", { preHandler: [app.authenticate] }, async (req) => {
    return prisma.copiedTrade.findMany({
      where: { copyTrader: { userId: req.user.id } },
      include: { trade: true, copyTrader: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });
}
