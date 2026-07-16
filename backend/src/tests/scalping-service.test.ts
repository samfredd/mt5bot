import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScalpingConfigSchema, ScalpingRiskSchema } from "../modules/scalping/scalping.schema.js";

const mocks = vi.hoisted(() => {
  const prisma = {
    user: { findFirst: vi.fn() },
    riskSettings: { findUnique: vi.fn() },
    trade: {
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
  };
  return {
    prisma,
    mt5: {
      accountInfo: vi.fn(),
      positions: vi.fn(),
      tick: vi.fn(),
      symbolInfo: vi.fn(),
    },
    audit: vi.fn(),
    logError: vi.fn(),
    detectSession: vi.fn(),
    assessNewsRisk: vi.fn(),
    buildRiskContext: vi.fn(),
    executeTrade: vi.fn(),
    validateTrade: vi.fn(),
    operationalTradingAvailable: vi.fn(),
    getBotState: vi.fn(),
    notify: vi.fn(),
    broadcast: vi.fn(),
    getCachedPlan: vi.fn(),
    getScalpingConfig: vi.fn(),
    getScalpingRisk: vi.fn(),
  };
});

vi.mock("../lib/prisma.js", () => ({ prisma: mocks.prisma }));
vi.mock("../lib/audit.js", () => ({ audit: mocks.audit, logError: mocks.logError }));
vi.mock("../modules/mt5/client.js", () => ({ mt5: mocks.mt5 }));
vi.mock("../modules/analysis/engine.js", () => ({ detectSession: mocks.detectSession }));
vi.mock("../modules/news/service.js", () => ({ assessNewsRisk: mocks.assessNewsRisk }));
vi.mock("../modules/trading/service.js", () => ({
  buildRiskContext: mocks.buildRiskContext,
  executeTrade: mocks.executeTrade,
}));
vi.mock("../modules/risk/engine.js", async () => {
  const actual = await vi.importActual<typeof import("../modules/risk/engine.js")>("../modules/risk/engine.js");
  return { ...actual, validateTrade: mocks.validateTrade };
});
vi.mock("../modules/system/state.js", () => ({
  operationalTradingAvailable: mocks.operationalTradingAvailable,
  getBotState: mocks.getBotState,
}));
vi.mock("../modules/notifications/service.js", () => ({ notify: mocks.notify }));
vi.mock("../modules/ws/hub.js", () => ({ broadcast: mocks.broadcast }));
vi.mock("../modules/scalping/scalping.ai.js", () => ({ getCachedPlan: mocks.getCachedPlan }));
vi.mock("../modules/scalping/scalping.state.js", () => ({
  getScalpingConfig: mocks.getScalpingConfig,
  getScalpingRisk: mocks.getScalpingRisk,
}));

describe("attemptScalpEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.user.findFirst.mockResolvedValue({ id: "admin1", role: "ADMIN", email: "admin@example.com" });
    mocks.prisma.riskSettings.findUnique.mockResolvedValue({
      maxLotSize: 0.01,
    });
    mocks.prisma.trade.findMany.mockImplementation((args: { where?: { status?: string } }) => {
      if (args?.where?.status === "CLOSED") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mocks.prisma.trade.count.mockResolvedValue(0);
    mocks.prisma.trade.aggregate.mockResolvedValue({ _sum: { profit: 0 } });

    mocks.getScalpingConfig.mockResolvedValue(ScalpingConfigSchema.parse({
      enabled: true,
      status: "running",
      symbols: ["USDJPY"],
      minAiConfidence: 0.72,
    }));
    mocks.getScalpingRisk.mockResolvedValue(ScalpingRiskSchema.parse({
      maxLotSize: 0.01,
      maxSharedCurrencyExposure: 10,
      allowedSessions: ["newyork"],
      maxSpreadPointsBySymbol: { USDJPY: 18 },
      pauseDuringNews: false,
    }));
    mocks.getBotState.mockResolvedValue({ emergencyStop: false });
    mocks.operationalTradingAvailable.mockResolvedValue(true);

    mocks.mt5.accountInfo.mockResolvedValue({ balance: 500, equity: 500, margin_level: 2000 });
    mocks.mt5.positions.mockResolvedValue([]);
    mocks.mt5.tick.mockResolvedValue({
      bid: 161.31,
      ask: 161.312,
      spread_points: 4,
      time: new Date().toISOString(),
    });
    mocks.mt5.symbolInfo.mockResolvedValue({
      symbol: "USDJPY",
      digits: 3,
      point: 0.001,
      tickSize: 0.001,
      tickValue: 0.62,
      volumeMin: 0.01,
      volumeMax: 500,
      volumeStep: 0.01,
      stopsLevelPoints: 0,
    });
    mocks.detectSession.mockReturnValue("newyork");
    mocks.assessNewsRisk.mockResolvedValue({ action: "allow", level: "low", reason: "ok", upcomingEvents: [] });
    mocks.getCachedPlan.mockReturnValue({
      symbol: "USDJPY",
      direction: "buy",
      score: 3,
      reasons: ["test signal"],
      ai: {
        symbol: "USDJPY",
        decision: "buy",
        confidence: 0.85,
        riskLevel: "low",
        shouldExecute: false,
        reasoning: "AI permits",
        validUntil: new Date(Date.now() + 60_000).toISOString(),
        aiDecisionId: "ai1",
        valid: true,
      },
      computedAt: Date.now(),
      validUntil: Date.now() + 60_000,
    });
    mocks.buildRiskContext.mockResolvedValue({ botRunning: true });
    mocks.validateTrade.mockReturnValue({
      ok: false,
      checks: [{ name: "exposure", passed: false, detail: "global exposure cap would block" }],
    });
    mocks.executeTrade.mockResolvedValue({ id: "trade1", mt5Ticket: "ticket1" });
  });

  it("blocks a scalp when the global risk engine vetoes it", async () => {
    const { attemptScalpEntries } = await import("../modules/scalping/scalping.service.js");

    const result = await attemptScalpEntries("test");

    expect(mocks.prisma.riskSettings.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.buildRiskContext).toHaveBeenCalledTimes(1);
    expect(mocks.validateTrade).toHaveBeenCalledTimes(1);
    expect(mocks.executeTrade).not.toHaveBeenCalled();
    expect(result.opened).toEqual([]);
    expect(result.blocked).toEqual([{ symbol: "USDJPY", reason: "global risk blocked: exposure" }]);
  });

  it("opens a scalp only after both scalping and global risk pass", async () => {
    mocks.validateTrade.mockReturnValue({
      ok: true,
      checks: [{ name: "all", passed: true, detail: "ok" }],
      adjustedLots: 0.01,
    });
    const { attemptScalpEntries } = await import("../modules/scalping/scalping.service.js");

    const result = await attemptScalpEntries("test");

    expect(mocks.validateTrade).toHaveBeenCalledTimes(1);
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);
    expect(result.opened).toEqual([{ symbol: "USDJPY", direction: "buy", ticket: "ticket1" }]);
    expect(result.blocked).toEqual([]);
  });
});
