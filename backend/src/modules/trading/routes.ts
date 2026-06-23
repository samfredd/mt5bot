import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { mt5 } from "../mt5/client.js";
import { assessNewsRisk } from "../news/service.js";
import { validateTrade, type TradeProposal } from "../risk/engine.js";
import { buildRiskContext, decideTrade, executeTrade, sessionNow } from "./service.js";
import { requireTwoFactor } from "../auth/service.js";
import { getBotState } from "../system/state.js";
import { currentAccountId } from "../mt5/account.js";
import { paperPerformance } from "./paper.js";
import { calculateExposure } from "../risk/exposure.js";

export async function tradingRoutes(app: FastifyInstance) {
  // --- Dashboard overview ---
  app.get("/api/overview", { preHandler: [app.authenticate] }, async (req) => {
    const [account, positions, state] = await Promise.all([mt5.accountInfo(), mt5.positions(), getBotState()]);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    // Daily P/L is shown next to the connected account's balance — scope it
    // to that account so switching accounts doesn't mix histories.
    const accountId = await currentAccountId(req.user.id);
    const dailyAgg = await prisma.trade.aggregate({
      _sum: { profit: true },
      where: { userId: req.user.id, closedAt: { gte: dayStart }, ...(accountId ? { accountId } : {}) },
    });
    const pendingApprovals = await prisma.trade.count({ where: { userId: req.user.id, status: "PENDING_APPROVAL" } });
    const activeStrategies = await prisma.strategy.findMany({ where: { userId: req.user.id, enabled: true }, select: { id: true, name: true } });
    const activeCopyTraders = await prisma.copyTrader.count({ where: { userId: req.user.id, active: true } });
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

  app.get("/api/exposure", { preHandler: [app.authenticate] }, async () => {
    const [positions, account] = await Promise.all([mt5.positions(), mt5.accountInfo()]);
    const exposure = calculateExposure(positions.map((position) => ({
      symbol: position.symbol,
      direction: position.type,
      lots: position.volume,
      price: position.price_current ?? position.price_open,
    })));
    return { accountEquity: account.equity, ...exposure };
  });

  app.get("/api/trades", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { status, limit, from, to, account } = req.query as {
      status?: string; limit?: string; from?: string; to?: string; account?: string;
    };
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
      return reply.code(400).send({ error: "from/to must be valid dates (ISO format)" });
    }
    // History is per trading account. Default: the account the terminal is
    // connected to right now. ?account=all shows everything; a saved account
    // id shows that account's history (e.g. while disconnected).
    let accountId: string | null = null;
    if (account && account !== "all" && account !== "current") {
      const saved = await prisma.mt5Account.findFirst({ where: { id: account, userId: req.user.id }, select: { id: true } });
      if (!saved) return reply.code(404).send({ error: "unknown account" });
      accountId = saved.id;
    } else if (account !== "all") {
      accountId = await currentAccountId(req.user.id);
    }
    return prisma.trade.findMany({
      where: {
        userId: req.user.id,
        ...(accountId ? { accountId } : {}),
        ...(status ? { status: status as never } : {}),
        ...(fromDate || toDate
          ? { createdAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit ?? 50), 500),
      include: { approval: true, strategy: { select: { name: true } } },
    });
  });

  app.get("/api/paper-trades/performance", { preHandler: [app.authenticate] }, async (req) => {
    return paperPerformance(req.user.id);
  });

  app.get("/api/paper-trades", { preHandler: [app.authenticate] }, async (req, reply) => {
    const query = z.object({
      status: z.enum(["OPEN", "CLOSED", "CANCELLED"]).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid paper-trade query", issues: query.error.issues });
    return prisma.paperTrade.findMany({
      where: { userId: req.user.id, ...(query.data.status ? { status: query.data.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: query.data.limit,
      include: { strategy: { select: { name: true } } },
    });
  });

  app.get("/api/execution-comparisons", { preHandler: [app.authenticate] }, async (req, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid execution-comparison query" });
    return prisma.executionComparison.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: query.data.limit,
      include: { trade: { select: { symbol: true, direction: true, status: true, openedAt: true, closedAt: true } } },
    });
  });

  app.get("/api/trades/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Scoped to the owner: a trade id must never expose another user's trade
    // (and its AI prompt/analysis) to whoever can guess the id.
    const trade = await prisma.trade.findFirst({ where: { id, userId: req.user.id }, include: { approval: true, aiAnalysis: true } });
    if (!trade) return reply.code(404).send({ error: "not found" });
    return trade;
  });

  // --- Approvals (approver chooses the lot size) ---
  app.post("/api/trades/:id/approve", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      totp: z.string().optional(),
      lots: z.number().positive().optional(),
      durationMin: z.number().int().positive().max(7 * 24 * 60).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid approval payload" });
    const state = await getBotState();
    if (!state.demoMode) {
      const ok = await requireTwoFactor(req.user.id, body.data.totp);
      if (!ok) return reply.code(403).send({ error: "2FA token required for live approvals" });
    }
    return decideTrade(id, true, req.user.email, "DASHBOARD", { lots: body.data.lots, durationMin: body.data.durationMin });
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
    durationMin: z.number().int().positive().max(7 * 24 * 60).optional(),
    totp: z.string().optional(),
  });

  app.post("/api/trades/manual", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = ManualTrade.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid payload" });
    const { symbol, direction, lots, stopLoss, takeProfit, durationMin, totp } = body.data;

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
    const ctx = await buildRiskContext(user, settings, account, tick.spread_points, null, sessionNow(), news.action, { twoFactorVerified, proposal });
    const risk = validateTrade(proposal, ctx);
    if (!risk.ok) {
      return reply.code(422).send({ error: "risk validation failed", checks: risk.checks.filter((c) => !c.passed) });
    }
    proposal.lots = risk.adjustedLots ?? proposal.lots;
    const trade = await executeTrade(user, proposal, {
      explanation: { manual: true, requestedBy: req.user.email, risk: { checks: risk.checks }, news },
      mode: "MANUAL",
      actor: req.user.email,
      durationMin,
      expectedSpreadPoints: tick.spread_points,
      actualSpreadPoints: tick.spread_points,
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
      aiMode: z.enum(["STRICT", "ADVISORY"]).optional(),
      minAiConfidence: z.number().min(0).max(1).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid scanner config", issues: body.error.issues });
    return setScannerConfig(body.data, req.user.email);
  });

  app.post("/api/scanner/run", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({ symbol: z.string().min(3).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid payload" });
    return runScanner("manual", { symbol: body.data.symbol });
  });

  // Broker symbol list, cached briefly — used by dropdowns. Brokers can
  // expose 10k+ instruments (every US stock); filter to the FX/metals/
  // indices/crypto the bot is designed for, majors first.
  const CURRENCIES = ["EUR", "USD", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"];
  const KNOWN_CFD_CORES = new Set([
    "XAUUSD", "XAGUSD", "XPTUSD", "XPDUSD",
    "BTCUSD", "ETHUSD", "LTCUSD", "XRPUSD",
    "US30", "US500", "USTEC", "NAS100", "SPX500",
    "DE40", "GER40", "UK100", "JP225",
    "WTI", "BRENT", "UKOIL", "USOIL", "NATGAS",
  ]);
  const brokerCore = (symbol: string) => symbol.replace(/[._-].*$/, "").replace(/[a-z]{1,5}$/, "").toUpperCase();
  const fxCore = (symbol: string) => symbol.match(/^([A-Z]{6})(?:[a-z]{1,5}|[._-].*)?$/)?.[1] ?? null;
  let symbolCache: { list: string[]; ts: number } | null = null;
  app.get("/api/symbols", { preHandler: [app.authenticate] }, async () => {
    if (!symbolCache || Date.now() - symbolCache.ts > 10 * 60_000) {
      const all = await mt5.symbols().catch(() => [] as string[]);
      const isFxPair = (s: string) => {
        const core = fxCore(s);
        return !!core && CURRENCIES.includes(core.slice(0, 3)) && CURRENCIES.includes(core.slice(3));
      };
      const fx = all.filter(isFxPair).sort();
      const cfd = all.filter((s) => KNOWN_CFD_CORES.has(brokerCore(s)) && !isFxPair(s)).sort();
      const majors = fx.filter((s) => s.includes("USD"));
      const crosses = fx.filter((s) => !s.includes("USD"));
      symbolCache = { list: [...new Set([...majors, ...cfd, ...crosses])].slice(0, 300), ts: Date.now() };
    }
    return { symbols: symbolCache.list };
  });

  app.get("/api/market/:symbol", { preHandler: [app.authenticate] }, async (req) => {
    const { symbol } = req.params as { symbol: string };
    const { timeframe = "H1" } = req.query as { timeframe?: string };
    const [tick, candles] = await Promise.all([mt5.tick(symbol), mt5.candles(symbol, timeframe, 200)]);
    return { tick, candles };
  });

  // --- Day-trading (intraday-only) mode ---
  const { getDayTradingConfig, setDayTradingConfig } = await import("./day-trading.js");

  app.get("/api/day-trading", { preHandler: [app.authenticate] }, async () => getDayTradingConfig());

  app.put("/api/day-trading", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({
      enabled: z.boolean().optional(),
      closeHourUtc: z.number().int().min(0).max(23).optional(),
      closeMinuteUtc: z.number().int().min(0).max(59).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid day-trading config" });
    return setDayTradingConfig(body.data, req.user.email);
  });
}
