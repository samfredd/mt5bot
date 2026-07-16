import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, any>[],
  incidents: [] as Record<string, unknown>[],
  ticks: new Map<string, { bid: number; ask: number; spread_points: number; time: string }>(),
  placeOrder: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    paperTrade: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `p${h.rows.length + 1}`, status: "OPEN", createdAt: new Date(), updatedAt: new Date(), ...data };
        h.rows.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        h.rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = h.rows.find((item) => item.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
  },
}));

vi.mock("../modules/mt5/client.js", () => ({
  mt5: {
    tick: vi.fn(async (symbol: string) => {
      const tick = h.ticks.get(symbol);
      if (!tick) throw new Error("missing tick");
      return tick;
    }),
    placeOrder: h.placeOrder,
  },
}));

vi.mock("../modules/incidents/service.js", () => ({
  reportIncident: vi.fn(async (incident: Record<string, unknown>) => {
    h.incidents.push(incident);
    return incident;
  }),
}));

const { buildPaperPromotionProposal, openPaperTrade, paperPerformance, reconcilePaperTrades } = await import("../modules/trading/paper.js");

const spec = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  tickValue: 1,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsLevelPoints: 0,
};

beforeEach(() => {
  h.rows = [];
  h.incidents = [];
  h.ticks = new Map();
  h.placeOrder.mockReset();
});

describe("paper trading", () => {
  it("rebuilds a promotable setup around the current price while preserving its risk geometry", () => {
    const result = buildPaperPromotionProposal({
      symbol: "EURUSD", direction: "BUY", lots: 0.2, entryPrice: 1.1,
      stopLoss: 1.098, takeProfit: 1.104, instrumentSpec: spec,
    }, 1.1005, 0.1);

    expect(result).toMatchObject({
      ok: true,
      proposal: { entry: 1.1005, stopLoss: 1.0985, takeProfit: 1.1045, lots: 0.1 },
    });
  });

  it("rejects paper promotion after price has moved more than half the initial risk", () => {
    const result = buildPaperPromotionProposal({
      symbol: "EURUSD", direction: "SELL", lots: 0.2, entryPrice: 1.1,
      stopLoss: 1.102, takeProfit: 1.096, instrumentSpec: spec,
    }, 1.0989);

    expect(result).toMatchObject({ ok: false });
  });

  it("opens at the executable side plus adverse slippage without a broker order", async () => {
    const trade = await openPaperTrade({
      userId: "u1",
      strategyId: "s1",
      proposal: { symbol: "EURUSD", direction: "buy", lots: 1, entry: 1.1, stopLoss: 1.099, takeProfit: 1.102, instrumentSpec: spec },
      tick: { bid: 1.1, ask: 1.1001, spread_points: 10, time: "2026-06-15T10:00:00.000Z" },
      expectedSlippagePoints: 2,
      commissionPerLot: 7,
      explanation: { gate: "passed" },
    });

    expect(trade).toMatchObject({ direction: "BUY", entryPrice: 1.10012, expectedCommission: 7, status: "OPEN" });
    expect(h.placeOrder).not.toHaveBeenCalled();
  });

  it("closes buys from bid and sells from ask when their stops or targets trigger", async () => {
    h.rows.push(
      { id: "buy", userId: "u1", symbol: "EURUSD", direction: "BUY", lots: 1, entryPrice: 1.10012, stopLoss: 1.099, takeProfit: 1.102, expectedCommission: 7, instrumentSpec: spec, status: "OPEN", openedAt: new Date("2026-06-15T10:00:00.000Z") },
      { id: "sell", userId: "u1", symbol: "GBPUSD", direction: "SELL", lots: 1, entryPrice: 1.25, stopLoss: 1.252, takeProfit: 1.248, expectedCommission: 7, instrumentSpec: { ...spec, symbol: "GBPUSD" }, status: "OPEN", openedAt: new Date("2026-06-15T10:00:00.000Z") },
    );
    h.ticks.set("EURUSD", { bid: 1.0989, ask: 1.099, spread_points: 10, time: "2026-06-15T10:10:00.000Z" });
    h.ticks.set("GBPUSD", { bid: 1.2478, ask: 1.2479, spread_points: 10, time: "2026-06-15T10:10:00.000Z" });

    await reconcilePaperTrades(new Date("2026-06-15T10:10:05.000Z"));

    expect(h.rows.find((row) => row.id === "buy")).toMatchObject({ status: "CLOSED", exitPrice: 1.0989, exitReason: "stop_loss" });
    expect(h.rows.find((row) => row.id === "sell")).toMatchObject({ status: "CLOSED", exitPrice: 1.2479, exitReason: "take_profit" });
  });

  it("calculates net paper performance after commission", async () => {
    h.rows.push(
      { id: "win", userId: "u1", status: "CLOSED", profit: 13 },
      { id: "loss", userId: "u1", status: "CLOSED", profit: -7 },
    );

    await expect(paperPerformance("u1")).resolves.toEqual({
      trades: 2,
      wins: 1,
      losses: 1,
      winRate: 50,
      netPnl: 6,
      profitFactor: 1.86,
    });
  });

  it("reports an incident when a paper trade cannot obtain a fresh tick", async () => {
    h.rows.push({
      id: "stale",
      userId: "u1",
      symbol: "EURUSD",
      direction: "BUY",
      lots: 1,
      entryPrice: 1.1,
      stopLoss: 1.09,
      takeProfit: 1.11,
      expectedCommission: 7,
      instrumentSpec: spec,
      status: "OPEN",
      openedAt: new Date("2026-06-15T09:00:00.000Z"),
    });

    await reconcilePaperTrades(new Date("2026-06-15T10:10:00.000Z"));

    expect(h.incidents).toContainEqual(expect.objectContaining({
      dedupeKey: "paper-trade:stale:stale",
      severity: "WARNING",
    }));
  });
});
