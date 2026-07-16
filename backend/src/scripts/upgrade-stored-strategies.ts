import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { StrategyConfigSchema, type StrategyConfig } from "../modules/strategy/types.js";

type Upgrade = { name?: string; type?: string; config: StrategyConfig };

const common = {
  version: 2,
  validationStatus: "unvalidated" as const,
  newsBehavior: "pause" as const,
};

const upgrades = new Map<string, Upgrade>([
  ["Trend Follower (H1)", {
    config: {
      ...common,
      symbols: ["EURUSD", "GBPUSD"], timeframes: ["H1", "H4"],
      entry: {
        style: "confluence", requireTrendAlignment: true,
        rsiOversold: 35, rsiOverbought: 65, useMacdCross: true, useCandlePatterns: false,
        minConfidence: 0.7, minRuleConfidence: 0.5, trendMinAdx: 20, maxExtensionAtr: 1.25,
      },
      exit: { stopLossAtrMult: 2, takeProfitAtrMult: 3.5, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.5 },
      maxTradesPerDay: 2, sessions: ["london", "london_newyork_overlap", "newyork"],
    },
  }],
  ["Price Action Scalper (M15)", {
    name: "Selective Price Action (M15/H1)", type: "intraday",
    config: {
      ...common,
      symbols: ["EURUSD", "GBPUSD"], timeframes: ["M15", "H1"],
      entry: {
        style: "confluence", requireTrendAlignment: true,
        rsiOversold: 30, rsiOverbought: 70, useMacdCross: false, useCandlePatterns: true,
        useRsi: false, minConfidence: 0.72, minRuleConfidence: 0.66,
        trendMinAdx: 18, maxExtensionAtr: 1,
      },
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.5, trailingStop: false },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 3, sessions: ["london", "london_newyork_overlap"],
    },
  }],
  ["Swing Trader (H4/D1)", {
    config: {
      ...common,
      symbols: ["XAUUSD", "EURUSD", "GBPJPY"], timeframes: ["H4", "D1"],
      entry: {
        style: "confluence", requireTrendAlignment: true,
        rsiOversold: 35, rsiOverbought: 65, useMacdCross: true, useCandlePatterns: true,
        minConfidence: 0.72, minRuleConfidence: 0.6, trendMinAdx: 18, maxExtensionAtr: 1.25,
      },
      exit: { stopLossAtrMult: 2.5, takeProfitAtrMult: 4.5, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.35 },
      maxTradesPerDay: 1, sessions: ["london", "london_newyork_overlap", "newyork"],
    },
  }],
  ["LAB-B H4 Strict Momentum", {
    name: "XAUUSD H4 Strict Momentum [VALIDATE]",
    config: {
      ...common,
      symbols: ["XAUUSD"], timeframes: ["H4", "D1"],
      entry: {
        style: "confluence", requireTrendAlignment: true,
        rsiOversold: 35, rsiOverbought: 65, useMacdCross: true, useCandlePatterns: true,
        minConfidence: 0.75, minRuleConfidence: 0.6, trendMinAdx: 22, maxExtensionAtr: 1,
      },
      exit: { stopLossAtrMult: 2.5, takeProfitAtrMult: 4.5, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 1, sessions: ["london", "london_newyork_overlap", "newyork"],
    },
  }],
  ["Mean Reversion (H1)", {
    name: "Filtered Mean Reversion (H1/H4)",
    config: {
      ...common,
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry: {
        style: "mean_reversion", requireTrendAlignment: false,
        rsiOversold: 25, rsiOverbought: 75, useMacdCross: false, useCandlePatterns: true,
        minConfidence: 0.72, regimeMaxAdx: 20,
      },
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.5, trailingStop: false },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 2, sessions: ["asia", "london", "newyork"],
    },
  }],
  ["Asian Range Breakout (H1)", {
    name: "Confirmed Asian Range Breakout (H1/H4)",
    config: {
      ...common,
      symbols: ["EURUSD", "GBPUSD"], timeframes: ["H1", "H4"],
      entry: {
        style: "breakout", requireTrendAlignment: true,
        rsiOversold: 30, rsiOverbought: 70, useMacdCross: false, useCandlePatterns: false,
        minConfidence: 0.72, breakoutBufferAtr: 0.15,
        breakoutMinRangeAtr: 0.75, breakoutMaxRangeAtr: 2.5,
        breakoutRequireHigherAlignment: true,
      },
      exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.75, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 1, sessions: ["london"],
    },
  }],
  ["Intraday Scalper (M1/M5) — Any Pair", {
    name: "Selective Intraday Trend (M15/H1) — Liquid FX", type: "trend_following",
    config: {
      ...common,
      symbols: ["EURUSD", "GBPUSD", "USDJPY"], timeframes: ["M15", "H1"],
      entry: {
        style: "confluence", requireTrendAlignment: true,
        rsiOversold: 35, rsiOverbought: 65, useMacdCross: true, useCandlePatterns: true,
        minConfidence: 0.72, minRuleConfidence: 0.6, trendMinAdx: 20, maxExtensionAtr: 1,
      },
      exit: { stopLossAtrMult: 2, takeProfitAtrMult: 3.5, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.25 },
      maxTradesPerDay: 4, sessions: ["london", "london_newyork_overlap", "newyork"],
    },
  }],
  ["Intraday Momentum (M5/M15) — Any Pair", {
    name: "Selective Momentum (M5/M15) — Liquid FX",
    config: {
      ...common,
      symbols: ["EURUSD", "GBPUSD", "USDJPY"], timeframes: ["M5", "M15"],
      entry: {
        style: "confluence", requireTrendAlignment: true,
        rsiOversold: 35, rsiOverbought: 65, useMacdCross: true, useCandlePatterns: true,
        minConfidence: 0.75, minRuleConfidence: 0.6, trendMinAdx: 22, maxExtensionAtr: 1,
      },
      exit: { stopLossAtrMult: 1.8, takeProfitAtrMult: 3, trailingStop: true },
      lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 0.2 },
      maxTradesPerDay: 4, sessions: ["london", "london_newyork_overlap"],
    },
  }],
]);

async function main() {
  const strategies = await prisma.strategy.findMany({ orderBy: { createdAt: "asc" } });
  const changed: string[] = [];
  const unmatched = strategies
    .filter((strategy) => !upgrades.has(strategy.name) && (strategy.config as { version?: number }).version !== 2)
    .map((strategy) => strategy.name);
  if (unmatched.length) throw new Error(`Refusing partial upgrade; unmatched strategies: ${unmatched.join(", ")}`);

  // Keep a database-resident rollback snapshot before the first mutation.
  await prisma.systemSetting.upsert({
    where: { key: "strategy-upgrade-v2-backup" },
    create: { key: "strategy-upgrade-v2-backup", value: { capturedAt: new Date().toISOString(), strategies } },
    update: { value: { capturedAt: new Date().toISOString(), strategies } },
  });

  for (const strategy of strategies) {
    const upgrade = upgrades.get(strategy.name);
    if (!upgrade) continue;
    const config = StrategyConfigSchema.parse(upgrade.config);
    const nextName = upgrade.name ?? strategy.name;
    await prisma.strategy.update({
      where: { id: strategy.id },
      data: {
        name: nextName,
        type: upgrade.type ?? strategy.type,
        config: config as object,
        // A changed hypothesis must earn its way back through OOS,
        // walk-forward and paper-forward validation.
        enabled: false,
      },
    });
    await audit({
      actor: "system:strategy-upgrade-v2", userId: strategy.userId,
      category: "strategy", action: "strategy_safely_upgraded",
      detail: { id: strategy.id, previousName: strategy.name, name: nextName, version: 2, enabled: false },
    });
    changed.push(nextName);
  }

  console.log(JSON.stringify({ upgraded: changed.length, strategies: changed }, null, 2));
}

main().finally(() => prisma.$disconnect());
