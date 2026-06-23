import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { runBacktest, runWalkForward } from "./engine.js";
import { fallbackTradingSpec } from "../risk/instruments.js";
import { runMonteCarlo } from "./monte-carlo.js";

const TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };

const BacktestBody = z.object({
  strategyId: z.string().min(1),
  symbol: z.string().min(3),
  days: z.number().int().min(7).max(1095).default(365),
  initialBalance: z.number().positive().default(10000),
  // Defaults model an Exness "Standard" account (spread-only, no commission):
  // majors sit ~8-12 pts, so 10 is a fair baseline. Override per symbol —
  // crosses (e.g. GBPJPY ~27) and metals run much wider. Raw/Zero accounts
  // should instead set spread ~2-3 and commissionPerLot ~7.
  spreadPoints: z.number().min(0).default(10),
  slippagePoints: z.number().min(0).default(2),
  commissionPerLot: z.number().min(0).default(0),
  maxLotSize: z.number().positive().default(1),
  sameBarPolicy: z.enum(["stop_first", "tp_first"]).default("stop_first"),
});

export async function backtestRoutes(app: FastifyInstance) {
  /**
   * Resolve a strategy + fetch enough history for it. Returns the data, or a
   * ready-to-send error (so both backtest routes share identical fetch rules).
   */
  async function loadCandles(userId: string, strategyId: string, symbol: string, days: number) {
    const strategy = await prisma.strategy.findFirst({ where: { id: strategyId, userId } });
    if (!strategy) return { ok: false as const, code: 404, message: "strategy not found" };

    const cfg = strategy.config as { timeframes?: string[] };
    const timeframes = cfg.timeframes?.length ? cfg.timeframes : ["H1"];
    const primaryTf = timeframes[0];
    const tfMin = TF_MINUTES[primaryTf] ?? 60;
    // Markets are closed ~2/7 of the week; request what the period implies.
    const wanted = Math.ceil((days * 1440 * (5 / 7)) / tfMin) + 250;

    let timeframeCandles: Record<string, Awaited<ReturnType<typeof mt5.candles>>>;
    let tick: Awaited<ReturnType<typeof mt5.tick>>;
    try {
      tick = await mt5.tick(symbol);
      timeframeCandles = Object.fromEntries(await Promise.all(timeframes.map(async (timeframe) => {
        const minutes = TF_MINUTES[timeframe] ?? tfMin;
        const count = timeframe === primaryTf
          ? wanted
          : Math.ceil((days * 1440 * (5 / 7)) / minutes) + 250;
        return [timeframe, await mt5.candles(symbol, timeframe, Math.min(count, 50000))] as const;
      })));
    } catch {
      return { ok: false as const, code: 502, message:
        `history fetch for ${symbol} ${primaryTf} timed out — MT5 is likely downloading the data. ` +
        `Open the ${symbol} chart in the terminal once (or just retry in ~30s).` };
    }
    const candles = timeframeCandles[primaryTf] ?? [];
    if (candles.length < 300) {
      return { ok: false as const, code: 422, message:
        `only ${candles.length} ${primaryTf} bars available for ${symbol} — need at least 300. ` +
        `If you recently restarted the bridge, open the ${symbol} chart in the terminal once so MT5 downloads history.` };
    }
    const instrument = await mt5.symbolInfo(symbol).catch(() => fallbackTradingSpec(symbol, tick.bid));
    return { ok: true as const, strategy, candles, timeframeCandles, tick, instrument };
  }

  app.post("/api/backtest", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = BacktestBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid payload" });
    const { strategyId, symbol, days, ...costCfg } = body.data;

    const loaded = await loadCandles(req.user.id, strategyId, symbol, days);
    if (!loaded.ok) return reply.code(loaded.code).send({ error: loaded.message });
    const { strategy, candles, timeframeCandles, tick, instrument } = loaded;

    const started = Date.now();
    const result = runBacktest(strategy, symbol.toUpperCase(), candles, { ...costCfg, instrument }, {
      timeframeCandles,
      asOfMs: Date.parse(tick.time),
    });
    await audit({
      actor: req.user.email, userId: req.user.id, category: "strategy", action: "backtest_run",
      detail: {
        strategy: strategy.name, symbol, bars: result.bars, ms: Date.now() - started,
        trades: result.stats.trades, returnPct: result.stats.returnPct, maxDD: result.stats.maxDrawdownPct,
      },
    });
    return {
      ...result,
      monteCarlo: runMonteCarlo(result.trades, costCfg.initialBalance, { iterations: 2000, seed: 1 }),
      strategyName: strategy.name,
    };
  });

  /** Walk-forward: same strategy across consecutive windows (robustness check). */
  app.post("/api/backtest/walk-forward", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = BacktestBody.extend({ folds: z.number().int().min(2).max(8).default(4) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid payload" });
    const { strategyId, symbol, days, folds, ...costCfg } = body.data;

    const loaded = await loadCandles(req.user.id, strategyId, symbol, days);
    if (!loaded.ok) return reply.code(loaded.code).send({ error: loaded.message });
    const { strategy, candles, timeframeCandles, tick, instrument } = loaded;

    const started = Date.now();
    const result = runWalkForward(strategy, symbol.toUpperCase(), candles, { ...costCfg, instrument }, folds, {
      timeframeCandles,
      asOfMs: Date.parse(tick.time),
    });
    await audit({
      actor: req.user.email, userId: req.user.id, category: "strategy", action: "walk_forward_run",
      detail: {
        strategy: strategy.name, symbol, folds: result.folds.length, ms: Date.now() - started,
        profitableFolds: result.consistency.profitableFolds, meanReturnPct: result.consistency.meanReturnPct,
      },
    });
    return { ...result, strategyName: strategy.name };
  });
}
