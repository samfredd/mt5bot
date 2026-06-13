import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { runBacktest } from "./engine.js";

const TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };

export async function backtestRoutes(app: FastifyInstance) {
  app.post("/api/backtest", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({
      strategyId: z.string().min(1),
      symbol: z.string().min(3),
      days: z.number().int().min(7).max(1095).default(365),
      initialBalance: z.number().positive().default(10000),
      spreadPoints: z.number().min(0).default(15),
      slippagePoints: z.number().min(0).default(2),
      commissionPerLot: z.number().min(0).default(7),
      maxLotSize: z.number().positive().default(1),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid payload" });
    const { strategyId, symbol, days, ...costCfg } = body.data;

    const strategy = await prisma.strategy.findFirst({ where: { id: strategyId, userId: req.user.id } });
    if (!strategy) return reply.code(404).send({ error: "strategy not found" });

    const cfg = strategy.config as { timeframes?: string[] };
    const primaryTf = cfg.timeframes?.[0] ?? "H1";
    const tfMin = TF_MINUTES[primaryTf] ?? 60;
    // Markets are closed ~2/7 of the week; request what the period implies.
    const wanted = Math.ceil((days * 1440 * (5 / 7)) / tfMin) + 250;

    let candles;
    try {
      candles = await mt5.candles(symbol, primaryTf, Math.min(wanted, 50000));
    } catch {
      return reply.code(502).send({
        error: `history fetch for ${symbol} ${primaryTf} timed out — MT5 is likely downloading the data. ` +
          `Open the ${symbol} chart in the terminal once (or just retry in ~30s).`,
      });
    }
    if (candles.length < 300) {
      return reply.code(422).send({
        error: `only ${candles.length} ${primaryTf} bars available for ${symbol} — need at least 300. ` +
          `If you recently restarted the bridge, open the ${symbol} chart in the terminal once so MT5 downloads history.`,
      });
    }

    const started = Date.now();
    const result = runBacktest(strategy, symbol.toUpperCase(), candles, costCfg);
    await audit({
      actor: req.user.email, userId: req.user.id, category: "strategy", action: "backtest_run",
      detail: {
        strategy: strategy.name, symbol, bars: result.bars, ms: Date.now() - started,
        trades: result.stats.trades, returnPct: result.stats.returnPct, maxDD: result.stats.maxDrawdownPct,
      },
    });
    // Cap the trade list in the response; stats cover everything.
    return { ...result, trades: result.trades.slice(-100), strategyName: strategy.name };
  });
}
