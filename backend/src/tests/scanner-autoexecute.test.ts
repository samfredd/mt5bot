import { beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackTradingSpec } from "../modules/risk/instruments.js";
import type { Candle } from "../modules/mt5/client.js";

const h = vi.hoisted(() => ({
  botState: { status: "running", mode: "AUTO", emergencyStop: false, demoMode: true, liveTradingEnabled: false, paperForward: false },
  created: [] as Record<string, unknown>[],
  executed: [] as Record<string, unknown>[],
  paperOpened: [] as Record<string, unknown>[],
  broadcasts: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  candles: [] as Candle[],
  scannerConfig: { enabled: true, symbols: ["EURUSD"], intervalMin: 10, maxPerDay: 8, minScore: 2, aiMode: "STRICT", minAiConfidence: 0.65 },
  aiDecision: {
    decision: "buy",
    confidence: 0.9,
    reasoning: "scanner setup accepted",
    risk_level: "low",
    suggested_stop_loss: null,
    suggested_take_profit: null,
    news_risk: "low",
    should_execute: true,
  },
  aiValid: true,
}));

const settings = {
  id: "rs1", userId: "admin", maxRiskPerTradePct: 1, maxDailyLossPct: 3, maxWeeklyLossPct: 6, maxDrawdownPct: 10,
  maxOpenTrades: 5, maxTradesPerSymbol: 2, maxTradesPerDay: 10, maxLotSize: 0.5, minRiskReward: 1.5,
  requireStopLoss: true, requireTakeProfit: false, maxSpreadPoints: 30, maxAtrVolatilityPct: 3,
  newsRiskLimit: "MEDIUM", pauseBeforeNewsMin: 30, pauseAfterNewsMin: 30, allowNewsTrading: false,
  allowedSessions: [], equityProtectionPct: 80, copyExposureLimitPct: 20, maxDailyCopiedTrades: 10,
  maxConsecutiveLosses: 3, maxCurrencyExposurePct: 600, maxCorrelatedExposurePct: 600,
  autoFlattenNewsEnabled: false, autoFlattenLeadMin: 15, autoFlattenMinimumImpact: "HIGH", autoFlattenSymbols: [],
};

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        where.key === "scanner"
          ? { key: "scanner", value: h.scannerConfig }
          : null),
      upsert: vi.fn(async () => ({})),
    },
    user: { findFirst: vi.fn(async () => ({ id: "admin", email: "admin@example.com", role: "ADMIN", liveTradingEnabled: false })) },
    riskSettings: { findUnique: vi.fn(async () => settings) },
    trade: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const trade = { id: `approval${h.created.length + 1}`, ...data };
        h.created.push(trade);
        return trade;
      }),
    },
  },
}));

vi.mock("../lib/audit.js", () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => { h.audits.push(entry); }),
  logError: vi.fn(async () => {}),
}));

vi.mock("../modules/mt5/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/mt5/client.js")>();
  return {
    ...actual,
    mt5: {
      symbols: vi.fn(async () => ["EURUSDm"]),
      resolveSymbol: vi.fn(async (symbol: string) => symbol === "EURUSD" ? "EURUSDm" : symbol),
      tick: vi.fn(async () => ({ symbol: "EURUSDm", bid: 1.1, ask: 1.1002, spread_points: 2, time: new Date().toISOString() })),
      candles: vi.fn(async () => h.candles),
      accountInfo: vi.fn(async () => ({ login: "100", balance: 10000, equity: 10000, margin: 0, free_margin: 10000, margin_level: 5000, currency: "USD", is_demo: true })),
      positions: vi.fn(async () => []),
      symbolInfo: vi.fn(async () => fallbackTradingSpec("EURUSDm", 1.1)),
    },
  };
});

vi.mock("../modules/analysis/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/analysis/engine.js")>();
  return {
    ...actual,
    buildMarketAnalysis: vi.fn(() => ({
      symbol: "EURUSDm",
      generatedAt: new Date().toISOString(),
      spreadPoints: 2,
      bid: 1.1,
      ask: 1.1002,
      session: "london",
      summary: "",
      referenceRange: null,
      timeframes: [
        {
          timeframe: "H1", trend: "bullish", structure: "higher_highs",
          rsi: 40, rsiPrevious: 35, macdHistogram: 0.1,
          macdPrevious: -0.1, signalPrevious: 0, macdCurrent: 0.2, signalCurrent: 0.1,
          emaFast: 1.1, emaSlow: 1.09, bollingerPosition: "inside",
          atr: 0.002, atrPct: 0.2, adx: 20, support: 1.09, resistance: 1.12,
          lastClose: 1.1005, candlePattern: null,
        },
        {
          timeframe: "H4", trend: "bullish", structure: "higher_highs",
          rsi: 45, rsiPrevious: 44, macdHistogram: 0.1,
          macdPrevious: 0.1, signalPrevious: 0, macdCurrent: 0.2, signalCurrent: 0.1,
          emaFast: 1.1, emaSlow: 1.09, bollingerPosition: "inside",
          atr: 0.003, atrPct: 0.3, adx: 20, support: 1.09, resistance: 1.12,
          lastClose: 1.1005, candlePattern: null,
        },
      ],
    })),
  };
});

vi.mock("../modules/news/service.js", () => ({
  assessNewsRisk: vi.fn(async () => ({ level: "low", action: "allow", reason: "", upcomingEvents: [] })),
}));

vi.mock("../modules/ai/service.js", () => ({
  askModel: vi.fn(async () => ({
    logId: "ai1",
    valid: h.aiValid,
    decision: h.aiDecision,
  })),
  getActiveProvider: vi.fn(async () => "ollama"),
  PURE_LOGIC_PROVIDER: "pure_logic",
  pureLogicDecision: vi.fn((direction: "buy" | "sell") => ({ ...h.aiDecision, decision: direction, confidence: 1 })),
}));

vi.mock("../modules/ai/prompts.js", () => ({
  buildTradePrompt: vi.fn(() => "prompt"),
}));

vi.mock("../modules/risk/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/risk/engine.js")>();
  return {
    ...actual,
    calculateLots: vi.fn(() => 0.1),
    validateTrade: vi.fn(() => ({ ok: true, checks: [{ name: "ok", passed: true, detail: "ok" }], adjustedLots: 0.1 })),
  };
});

vi.mock("../modules/trading/service.js", () => ({
  buildRiskContext: vi.fn(async () => ({})),
  sessionNow: vi.fn(() => "london"),
  executeTrade: vi.fn(async (_user: unknown, proposal: Record<string, unknown>, opts: Record<string, unknown>) => {
    const trade = { id: `exec${h.executed.length + 1}`, status: "EXECUTED", symbol: proposal.symbol, mode: opts.mode };
    h.executed.push({ proposal, opts, trade });
    return trade;
  }),
}));

vi.mock("../modules/trading/paper.js", () => ({
  openPaperTrade: vi.fn(async (input: Record<string, unknown>) => {
    const trade = { id: `paper${h.paperOpened.length + 1}`, status: "OPEN", symbol: (input.proposal as { symbol?: string }).symbol };
    h.paperOpened.push({ input, trade });
    return trade;
  }),
}));

vi.mock("../modules/system/state.js", () => ({
  getBotState: vi.fn(async () => h.botState),
}));

vi.mock("../modules/mt5/account.js", () => ({
  accountIdForLogin: vi.fn(async () => "acc1"),
}));

vi.mock("../modules/notifications/service.js", () => ({
  notify: vi.fn(async () => {}),
}));

vi.mock("../modules/ws/hub.js", () => ({
  broadcast: vi.fn((event: string, data: unknown) => { h.broadcasts.push({ event, data }); }),
}));

const { runScanner } = await import("../modules/trading/scanner.js");

beforeEach(() => {
  h.botState = { status: "running", mode: "AUTO", emergencyStop: false, demoMode: true, liveTradingEnabled: false, paperForward: false };
  h.created = [];
  h.executed = [];
  h.paperOpened = [];
  h.broadcasts = [];
  h.audits = [];
  h.scannerConfig = { enabled: true, symbols: ["EURUSD"], intervalMin: 10, maxPerDay: 8, minScore: 2, aiMode: "STRICT", minAiConfidence: 0.65 };
  h.aiDecision = {
    decision: "buy",
    confidence: 0.9,
    reasoning: "scanner setup accepted",
    risk_level: "low",
    suggested_stop_loss: null,
    suggested_take_profit: null,
    news_risk: "low",
    should_execute: true,
  };
  h.aiValid = true;
  const now = Date.now();
  h.candles = Array.from({ length: 201 }, (_, i) => ({
    time: new Date(now - (201 - i) * 60_000).toISOString(),
    open: 1.1,
    high: 1.101,
    low: 1.099,
    close: 1.1005,
    tick_volume: 100,
  }));
});

describe("runScanner AUTO mode", () => {
  it("executes a scanner candidate instead of creating a pending approval", async () => {
    const result = await runScanner("schedule");

    expect(result.executed).toMatchObject({ tradeId: "exec1", symbol: "EURUSDm", direction: "buy", lots: 0.1 });
    expect(result.suggested).toBeNull();
    expect(h.executed).toHaveLength(1);
    expect(h.created).toHaveLength(0);
    expect(h.executed[0].opts).toMatchObject({ mode: "AUTO", actor: "scanner:schedule:auto" });
  });

  it("opens a paper-forward trade instead of a broker order when paper-forward is enabled", async () => {
    h.botState.paperForward = true;

    const result = await runScanner("schedule");

    expect(result.paper).toMatchObject({ tradeId: "paper1", symbol: "EURUSDm", direction: "buy", lots: 0.1 });
    expect(result.executed).toBeUndefined();
    expect(h.paperOpened).toHaveLength(1);
    expect(h.executed).toHaveLength(0);
    expect(h.created).toHaveLength(0);
  });

  it("does not execute when the strict AI gate vetoes the scanner candidate", async () => {
    h.aiDecision = { ...h.aiDecision, decision: "avoid", confidence: 0.6, reasoning: "higher timeframe consolidation" };

    const result = await runScanner("schedule");

    expect(result.executed).toBeUndefined();
    expect(result.suggested).toBeNull();
    expect(result.skippedReason).toContain("blocked by AI gate");
    expect(h.executed).toHaveLength(0);
    expect(h.audits).toContainEqual(expect.objectContaining({
      action: "ai_veto",
      detail: expect.objectContaining({ aiMode: "STRICT", blockedExecution: true, requiredConfidence: 0.65 }),
    }));
  });

  it("executes in advisory AI mode while still recording the veto", async () => {
    h.scannerConfig = { ...h.scannerConfig, aiMode: "ADVISORY" };
    h.aiDecision = { ...h.aiDecision, decision: "avoid", confidence: 0.6, reasoning: "higher timeframe consolidation" };

    const result = await runScanner("schedule");

    expect(result.executed).toMatchObject({ tradeId: "exec1", symbol: "EURUSDm", direction: "buy", lots: 0.1 });
    expect(h.executed).toHaveLength(1);
    expect(h.audits).toContainEqual(expect.objectContaining({
      action: "ai_veto",
      detail: expect.objectContaining({ aiMode: "ADVISORY", blockedExecution: false }),
    }));
  });
});
