import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { currentAccountId } from "../mt5/account.js";

/**
 * Performance analytics computed from actual closed-trade history.
 * The numbers professionals judge a system by: win rate, profit factor,
 * and expectancy — never win rate alone.
 */

interface Bucket {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  totalPnl: number;
  maxLossStreak: number;
  bestTrade: number | null;
  worstTrade: number | null;
}

function computeBucket(label: string, profits: number[]): Bucket {
  const wins = profits.filter((p) => p > 0);
  const losses = profits.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const decided = wins.length + losses.length;
  let streak = 0;
  let maxStreak = 0;
  for (const p of profits) {
    streak = p < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  return {
    label,
    trades: profits.length,
    wins: wins.length,
    losses: losses.length,
    winRate: decided ? Number(((wins.length / decided) * 100).toFixed(1)) : null,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : wins.length ? null : 0,
    expectancy: profits.length ? Number((profits.reduce((a, b) => a + b, 0) / profits.length).toFixed(2)) : null,
    avgWin: wins.length ? Number((grossProfit / wins.length).toFixed(2)) : null,
    avgLoss: losses.length ? Number((grossLoss / losses.length).toFixed(2)) : null,
    totalPnl: Number(profits.reduce((a, b) => a + b, 0).toFixed(2)),
    maxLossStreak: maxStreak,
    bestTrade: profits.length ? Number(Math.max(...profits).toFixed(2)) : null,
    worstTrade: profits.length ? Number(Math.min(...profits).toFixed(2)) : null,
  };
}

export async function analyticsRoutes(app: FastifyInstance) {
  app.get("/api/analytics", { preHandler: [app.authenticate] }, async (req) => {
    const { days, account } = req.query as { days?: string; account?: string };
    const since = new Date(Date.now() - Math.min(Number(days ?? 90), 365) * 86400_000);

    // Stats are per trading account (default: the connected one) — mixing
    // accounts would make win rate / profit factor meaningless. ?account=all
    // keeps the old combined view.
    const accountId = account === "all"
      ? null
      : account && account !== "current"
        ? account
        : await currentAccountId(req.user.id);
    const accountScope = accountId ? { accountId } : {};

    const trades = await prisma.trade.findMany({
      where: { userId: req.user.id, ...accountScope, status: "CLOSED", profit: { not: null }, closedAt: { gte: since } },
      include: { strategy: { select: { name: true } } },
      orderBy: { closedAt: "asc" },
    });

    const profitsOf = (list: typeof trades) => list.map((t) => t.profit as number);
    const groupLabel = (t: (typeof trades)[number]) =>
      t.strategy?.name ?? (t.mode === "COPY" ? "Copy trading" : "Manual");

    const byStrategy = new Map<string, typeof trades>();
    const bySymbol = new Map<string, typeof trades>();
    for (const t of trades) {
      const s = groupLabel(t);
      byStrategy.set(s, [...(byStrategy.get(s) ?? []), t]);
      bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) ?? []), t]);
    }

    // Daily P/L series for the chart (last 30 days)
    const daily = new Map<string, number>();
    for (const t of trades) {
      const day = t.closedAt!.toISOString().slice(0, 10);
      daily.set(day, (daily.get(day) ?? 0) + (t.profit as number));
    }
    const dailySeries = [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-30)
      .map(([date, pnl]) => ({ date, pnl: Number(pnl.toFixed(2)) }));

    const pendingProfit = await prisma.trade.count({
      where: { userId: req.user.id, ...accountScope, status: "CLOSED", profit: null, closedAt: { gte: since } },
    });

    return {
      since: since.toISOString(),
      overall: computeBucket("Overall", profitsOf(trades)),
      byStrategy: [...byStrategy.entries()].map(([label, list]) => computeBucket(label, profitsOf(list))),
      bySymbol: [...bySymbol.entries()].map(([label, list]) => computeBucket(label, profitsOf(list))),
      dailySeries,
      // Trades closed before profit reconciliation ran (excluded from stats)
      unreconciledTrades: pendingProfit,
    };
  });
}
