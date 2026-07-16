import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stored: [] as Record<string, any>[],
  trade: null as Record<string, any> | null,
}));

vi.mock("../modules/system/operational-config.js", () => ({
  getOperationalConfig: vi.fn(async () => ({
    tradingMemoryEnabled: true,
    tradingMemoryLookbackTrades: 200,
    tradingMemoryMinSamples: 3,
  })),
}));

vi.mock("../lib/audit.js", () => ({ audit: vi.fn(async () => ({})) }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    trade: {
      findUnique: vi.fn(async () => h.trade),
      findMany: vi.fn(async () => []),
    },
    tradingMemory: {
      upsert: vi.fn(async ({ create, update }: { create: Record<string, any>; update: Record<string, any> }) => {
        const existing = h.stored.find((row) => row.tradeId === create.tradeId);
        if (existing) Object.assign(existing, update);
        else h.stored.push({ id: "m1", ...create, createdAt: new Date("2026-07-16T00:00:00Z"), updatedAt: new Date("2026-07-16T00:00:00Z") });
        return h.stored.find((row) => row.tradeId === create.tradeId);
      }),
      findMany: vi.fn(async () => h.stored),
    },
  },
}));

const { learnFromClosedTrade, relevantMemory } = await import("../modules/memory/service.js");

beforeEach(() => {
  h.stored = [];
  h.trade = {
    id: "t1", userId: "u1", status: "CLOSED", profit: -12.5, symbol: "EURUSD", direction: "BUY",
    strategyId: "s1", strategy: { name: "Trend H1" }, entryPrice: 1.1, stopLoss: 1.099,
    brokerExitPrice: 1.099, accountId: "a1", mode: "AUTO",
    explanation: {
      ai: { decision: "buy", confidence: 0.88, reasonsAgainst: ["momentum conflict"] },
      context: { marketRegime: "range", confidenceEngine: { conflicts: ["M5 disagreed with H1"] } },
      news: { level: "high" },
    },
  };
});

describe("persistent trading memory", () => {
  it("turns a realized loss into an idempotent, explainable lesson", async () => {
    await learnFromClosedTrade("t1");
    await learnFromClosedTrade("t1");

    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]).toMatchObject({ tradeId: "t1", outcome: "LOSS", profit: -12.5, marketRegime: "range", newsRisk: "high" });
    expect(h.stored[0].mistakes.join(" ")).toContain("High-confidence approval");
    expect(h.stored[0].mistakes.join(" ")).toContain("high news risk");
  });

  it("retrieves matching lessons but labels small samples as insufficient", async () => {
    await learnFromClosedTrade("t1");
    const prompt = await relevantMemory({ userId: "u1", symbol: "EURUSD", strategyId: "s1", direction: "buy", source: "strategy" });

    expect(prompt).toContain("only 1 relevant completed trade");
    expect(prompt).toContain("below the 3-trade minimum");
  });
});
