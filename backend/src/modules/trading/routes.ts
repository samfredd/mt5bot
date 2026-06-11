import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { mt5 } from "../mt5/client.js";
import { assessNewsRisk } from "../news/service.js";
import { validateTrade, type TradeProposal } from "../risk/engine.js";
import { buildRiskContext, decideTrade, executeTrade, sessionNow } from "./service.js";
import { requireTwoFactor } from "../auth/service.js";
import { getBotState } from "../system/state.js";

export async function tradingRoutes(app: FastifyInstance) {
  // --- Dashboard overview ---
  app.get("/api/overview", { preHandler: [app.authenticate] }, async () => {
    const [account, positions, state] = await Promise.all([mt5.accountInfo(), mt5.positions(), getBotState()]);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const dailyAgg = await prisma.trade.aggregate({ _sum: { profit: true }, where: { closedAt: { gte: dayStart } } });
    const pendingApprovals = await prisma.trade.count({ where: { status: "PENDING_APPROVAL" } });
    const activeStrategies = await prisma.strategy.findMany({ where: { enabled: true }, select: { id: true, name: true } });
    const activeCopyTraders = await prisma.copyTrader.count({ where: { active: true } });
    return {
      account,
      botState: state,
      openTrades: positions,
      floatingPnl: positions.reduce((a, p) => a + p.profit, 0),
      dailyPnl: dailyAgg._sum.profit ?? 0,
      pendingApprovals,
      activeStrategies,
      activeCopyTraders,
    };
  });

  app.get("/api/trades", { preHandler: [app.authenticate] }, async (req) => {
    const { status, limit } = req.query as { status?: string; limit?: string };
    return prisma.trade.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit ?? 50), 200),
      include: { approval: true, strategy: { select: { name: true } } },
    });
  });

  app.get("/api/trades/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const trade = await prisma.trade.findUnique({ where: { id }, include: { approval: true, aiAnalysis: true } });
    if (!trade) return reply.code(404).send({ error: "not found" });
    return trade;
  });

  // --- Approvals (approver chooses the lot size) ---
  app.post("/api/trades/:id/approve", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ totp: z.string().optional(), lots: z.number().positive().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid approval payload" });
    const state = await getBotState();
    if (!state.demoMode) {
      const ok = await requireTwoFactor(req.user.id, body.data.totp);
      if (!ok) return reply.code(403).send({ error: "2FA token required for live approvals" });
    }
    return decideTrade(id, true, req.user.email, "DASHBOARD", { lots: body.data.lots });
  });

  app.post("/api/trades/:id/reject", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    const { id } = req.params as { id: string };
    return decideTrade(id, false, req.user.email, "DASHBOARD");
  });

  // --- Manual trading (still risk-gated — manual is never a bypass) ---
  const ManualTrade = z.object({
    symbol: z.string().min(3),
    direction: z.enum(["buy", "sell"]),
    lots: z.number().positive(),
    stopLoss: z.number().positive().nullable(),
    takeProfit: z.number().positive().nullable(),
    totp: z.string().optional(),
  });

  app.post("/api/trades/manual", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = ManualTrade.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid payload" });
    const { symbol, direction, lots, stopLoss, takeProfit, totp } = body.data;

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const settings = await prisma.riskSettings.findUnique({ where: { userId: req.user.id } });
    if (!user || !settings) return reply.code(409).send({ error: "risk settings not configured" });

    const state = await getBotState();
    const twoFactorVerified = state.demoMode ? false : await requireTwoFactor(user.id, totp);
    if (!state.demoMode && !twoFactorVerified) {
      return reply.code(403).send({ error: "2FA token required for live manual trades" });
    }

    const [tick, account] = await Promise.all([mt5.tick(symbol), mt5.accountInfo()]);
    const news = await assessNewsRisk(symbol, settings);
    const proposal: TradeProposal = {
      symbol, direction, lots,
      entry: direction === "buy" ? tick.ask : tick.bid,
      stopLoss, takeProfit,
    };
    const ctx = await buildRiskContext(user, settings, account, tick.spread_points, null, sessionNow(), news.action, { twoFactorVerified });
    const risk = validateTrade(proposal, ctx);
    if (!risk.ok) {
      return reply.code(422).send({ error: "risk validation failed", checks: risk.checks.filter((c) => !c.passed) });
    }
    proposal.lots = risk.adjustedLots ?? proposal.lots;
    const trade = await executeTrade(user, proposal, {
      explanation: { manual: true, requestedBy: req.user.email, risk: { checks: risk.checks }, news },
      mode: "MANUAL", actor: req.user.email,
    });
    return trade;
  });

  // --- Position management ---
  app.post("/api/positions/:ticket/close", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    const { ticket } = req.params as { ticket: string };
    const result = await mt5.closePosition(ticket, req.user.email);
    if (result.ok) {
      const profit = (result as { profit?: number }).profit;
      await prisma.trade.updateMany({
        where: { mt5Ticket: ticket, status: "EXECUTED" },
        // Profit may be absent (real bridge) — the scheduler backfills it
        // from deal history within a minute.
        data: { status: "CLOSED", closedAt: new Date(), profit: profit ?? null },
      });
    }
    return result;
  });

  app.post("/api/positions/:ticket/modify", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const { ticket } = req.params as { ticket: string };
    const body = z.object({ sl: z.number().positive().optional(), tp: z.number().positive().optional() }).safeParse(req.body);
    if (!body.success || (!body.data.sl && !body.data.tp)) return reply.code(400).send({ error: "provide sl and/or tp" });
    return mt5.modifyPosition(ticket, body.data, req.user.email);
  });

  // --- Autonomous scanner ---
  const { getScannerConfig, setScannerConfig, runScanner } = await import("./scanner.js");

  app.get("/api/scanner", { preHandler: [app.authenticate] }, async () => getScannerConfig());

  app.put("/api/scanner", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({
      enabled: z.boolean().optional(),
      symbols: z.array(z.string().min(3)).min(1).max(30).optional(),
      intervalMin: z.number().int().min(2).max(120).optional(),
      maxPerDay: z.number().int().min(1).max(50).optional(),
      minScore: z.number().int().min(2).max(6).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid scanner config", issues: body.error.issues });
    return setScannerConfig(body.data, req.user.email);
  });

  app.post("/api/scanner/run", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async () => {
    return runScanner("manual");
  });

  app.get("/api/market/:symbol", { preHandler: [app.authenticate] }, async (req) => {
    const { symbol } = req.params as { symbol: string };
    const { timeframe = "H1" } = req.query as { timeframe?: string };
    const [tick, candles] = await Promise.all([mt5.tick(symbol), mt5.candles(symbol, timeframe, 200)]);
    return { tick, candles };
  });
}
