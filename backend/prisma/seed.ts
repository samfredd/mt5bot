import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

/** Seed: demo admin + preset strategy + default risk settings + sample copy trader. */
async function main() {
  const email = "admin@example.com";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("seed: admin already exists, skipping");
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash("changeme123", 12),
      role: "ADMIN",
      riskSettings: { create: {} },
    },
  });

  await prisma.strategy.create({
    data: {
      userId: user.id,
      name: "Trend Follower (H1)",
      type: "trend_following",
      enabled: false,
      config: {
        symbols: ["EURUSD", "GBPUSD"],
        timeframes: ["H1", "H4"],
        entry: { requireTrendAlignment: true, rsiOversold: 35, rsiOverbought: 65, useMacdCross: true, useCandlePatterns: false, minConfidence: 0.65 },
        exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 3.0, trailingStop: true },
        lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 1.0 },
        maxTradesPerDay: 3,
        sessions: ["london", "newyork", "london_newyork_overlap"],
        newsBehavior: "pause",
      },
    },
  });

  await prisma.copyTrader.create({
    data: {
      userId: user.id,
      name: "Sample Steady Trader",
      source: "manual",
      riskScore: 32,
      metrics: {
        winRate: 58, profitFactor: 1.6, maxDrawdownPct: 12, avgMonthlyReturnPct: 4.5,
        consistency: 72, accountAgeMonths: 30, tradesPerWeek: 14, avgTradeDurationHours: 6,
        maxLossStreak: 4, recoveryBehavior: "good", symbolSpecialization: ["EURUSD", "GBPUSD"],
        lotBehavior: "consistent", newsBehavior: "avoids",
      },
      copyRules: { lotMultiplier: 1, stopAfterLossStreak: 5, maxSourceLot: 1 },
    },
  });

  await prisma.systemSetting.upsert({
    where: { key: "bot_state" },
    create: { key: "bot_state", value: { status: "stopped", mode: "MANUAL", emergencyStop: false, demoMode: true, liveTradingEnabled: false } },
    update: {},
  });

  console.log("seed complete — login: admin@example.com / changeme123 (CHANGE THIS PASSWORD)");
}

main().finally(() => prisma.$disconnect());
