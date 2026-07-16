import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrategyConfigSchema } from "../modules/strategy/types.js";
import { fallbackTradingSpec } from "../modules/risk/instruments.js";
import type { Candle } from "../modules/mt5/client.js";

/**
 * Tests the real money path — evaluateAndMaybeTrade / executeTrade /
 * decideTrade / enforceEquityGuardian — with the I/O boundary mocked but the
 * REAL risk engine running. This is the previously-untested orchestration
 * where a regression would actually cost money.
 */

// Shared, test-controllable state (hoisted so the vi.mock factories can read it).
const h = vi.hoisted(() => ({
  botState: { status: "running", mode: "AUTO", emergencyStop: false, demoMode: true, liveTradingEnabled: false, paperForward: false },
  account: { login: "100", balance: 10000, equity: 10000, margin: 0, free_margin: 10000, margin_level: 5000, currency: "USD", is_demo: true },
  positions: [] as { ticket: string; symbol: string; volume: number; profit: number }[],
  tick: { symbol: "EURUSD", bid: 1.085, ask: 1.0852, spread_points: 2, time: new Date().toISOString() },
  candles: [] as Candle[],
  order: { ok: true, ticket: "ord1", position_id: "pos1", price: 1.0852 } as { ok: boolean; ticket?: string; position_id?: string; price?: number; error?: string },
  ai: { decision: "buy", confidence: 0.9, reasoning: "ok", risk_level: "low", suggested_stop_loss: null as number | null, suggested_take_profit: null as number | null, news_risk: "low", should_execute: true },
  aiValid: true,
  newsAction: "allow" as "allow" | "reduce" | "pause",
  analysisSpread: 2,
  signalDirection: "buy" as "buy" | "sell" | null,
  levels: { entry: 1.0852, stopLoss: 1.0832, takeProfit: 1.0892 } as { entry: number; stopLoss: number; takeProfit: number } | null,
  accountId: null as string | null,
  operational: true,
  setStateCalls: [] as Record<string, unknown>[],
  created: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  closed: [] as string[],
  notes: [] as { type: string; title: string }[],
  audits: [] as { action: string }[],
  broadcasts: [] as { event: string }[],
  incidents: [] as { dedupeKey: string; severity: string }[],
  orders: [] as Record<string, unknown>[],
  paperOpened: [] as Record<string, unknown>[],
  comparisons: [] as Record<string, unknown>[],
  tradeForDecide: null as Record<string, unknown> | null,
  adminUser: { id: "admin", email: "a@x.com", role: "ADMIN", liveTradingEnabled: false },
}));

const settings = {
  id: "rs1", userId: "u1", maxRiskPerTradePct: 1, maxDailyLossPct: 3, maxWeeklyLossPct: 6, maxDrawdownPct: 10,
  maxOpenTrades: 5, maxTradesPerSymbol: 2, maxTradesPerDay: 10, maxLotSize: 0.5, minRiskReward: 1.5,
  requireStopLoss: true, requireTakeProfit: false, maxSpreadPoints: 30, maxAtrVolatilityPct: 3,
  newsRiskLimit: "MEDIUM", pauseBeforeNewsMin: 30, pauseAfterNewsMin: 30, allowNewsTrading: false,
  // Empty = any session allowed; keeps tests independent of wall-clock time
  // (decideTrade re-checks risk with the live sessionNow()).
  allowedSessions: [], equityProtectionPct: 80, copyExposureLimitPct: 20,
  maxDailyCopiedTrades: 10, maxConsecutiveLosses: 3,
  maxCurrencyExposurePct: 600, maxCorrelatedExposurePct: 600,
  autoFlattenNewsEnabled: false, autoFlattenLeadMin: 15, autoFlattenMinimumImpact: "HIGH", autoFlattenSymbols: [],
};

const strategyConfig = StrategyConfigSchema.parse({
  symbols: ["EURUSD"], timeframes: ["H1"],
  entry: { style: "confluence", minConfidence: 0.6 },
  exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 2.5 },
  lotSizing: { method: "risk_pct", riskPct: 1 },
});

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    riskSettings: { findUnique: vi.fn(async () => settings) },
    trade: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const t = { id: `t${h.created.length + 1}`, ...data }; h.created.push(t); return t; }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const prior = [...h.created, ...h.updated].reverse().find((item) => item.id === where.id) ?? {};
        const t = { ...prior, id: where.id, ...data };
        h.updated.push(t);
        if (h.tradeForDecide && h.tradeForDecide.id === where.id) Object.assign(h.tradeForDecide, data);
        return t;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: string; status?: string }; data: Record<string, unknown> }) => {
        const trade = h.tradeForDecide;
        if (!trade || (where.id && trade.id !== where.id) || (where.status && trade.status !== where.status)) return { count: 0 };
        Object.assign(trade, data);
        h.updated.push({ id: trade.id, ...data });
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => h.tradeForDecide),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { profit: 0 } })),
      findMany: vi.fn(async () => []),
    },
    tradeApproval: { update: vi.fn(async () => ({})) },
    systemSetting: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    mt5Account: { findFirst: vi.fn(async () => null) },
    user: { findFirst: vi.fn(async () => h.adminUser) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../lib/audit.js", () => ({
  audit: vi.fn(async ({ action }: { action: string }) => { h.audits.push({ action }); }),
  logError: vi.fn(async () => {}),
}));

vi.mock("../modules/mt5/client.js", () => ({
  mt5: {
    tick: vi.fn(async () => h.tick),
    candles: vi.fn(async () => h.candles),
    accountInfo: vi.fn(async () => h.account),
    positions: vi.fn(async () => h.positions),
    placeOrder: vi.fn(async (order: Record<string, unknown>) => { h.orders.push(order); return h.order; }),
    closePosition: vi.fn(async (ticket: string) => { h.closed.push(ticket); return { ok: true }; }),
    symbolInfo: vi.fn(async (s: string) => fallbackTradingSpec(s, 1.085)),
  },
}));

vi.mock("../modules/analysis/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/analysis/engine.js")>();
  return {
    ...actual, // keep detectSession / analyzeTimeframe / asianRange real
    buildMarketAnalysis: vi.fn(() => ({
      symbol: "EURUSD", generatedAt: "", spreadPoints: h.analysisSpread, bid: h.tick.bid, ask: h.tick.ask,
      session: "london", timeframes: [{ atrPct: 0.5, atr: 0.002 }], summary: "", referenceRange: null,
    })),
  };
});

vi.mock("../modules/news/service.js", () => ({
  assessNewsRisk: vi.fn(async () => ({ level: "low", action: h.newsAction, reason: "", upcomingEvents: [] })),
}));

vi.mock("../modules/strategy/service.js", () => ({
  // Inline config (no reference to a hoisted module-level const) so the mock
  // registers reliably; the pipeline only reads entry.minConfidence + lotSizing.
  evaluateStrategy: vi.fn(() => ({
    symbol: "EURUSD", direction: h.signalDirection, reasons: ["bull"], strategyId: "s1", strategyName: "S", confidence: 0.9,
    config: { entry: { minConfidence: 0.6 }, exit: { trailingStop: false }, lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 1 } },
  })),
  deriveLevels: vi.fn(() => h.levels),
}));

vi.mock("../modules/ai/service.js", () => ({
  askModel: vi.fn(async () => ({ decision: h.ai, logId: "log1", valid: h.aiValid })),
  getActiveProvider: vi.fn(async () => "ollama"),
  PURE_LOGIC_PROVIDER: "pure_logic",
  pureLogicDecision: vi.fn((direction: "buy" | "sell") => ({ ...h.ai, decision: direction, confidence: 1 })),
}));

vi.mock("../modules/mt5/account.js", () => ({
  accountIdForLogin: vi.fn(async () => h.accountId),
  currentAccountId: vi.fn(async () => h.accountId),
}));

vi.mock("../modules/system/state.js", () => ({
  getBotState: vi.fn(async () => h.botState),
  setBotState: vi.fn(async (patch: Record<string, unknown>) => { h.setStateCalls.push(patch); Object.assign(h.botState, patch); return h.botState; }),
  operationalTradingAvailable: vi.fn(async () => h.operational),
}));

vi.mock("../modules/incidents/service.js", () => ({
  reportIncident: vi.fn(async (incident: { dedupeKey: string; severity: string }) => {
    h.incidents.push(incident);
    return incident;
  }),
}));

vi.mock("../modules/trading/paper.js", () => ({
  openPaperTrade: vi.fn(async (input: Record<string, unknown>) => {
    const trade = { id: `p${h.paperOpened.length + 1}`, status: "OPEN", ...input };
    h.paperOpened.push(trade);
    return trade;
  }),
}));

vi.mock("../modules/trading/execution-comparison.js", () => ({
  recordEntryComparison: vi.fn(async (input: Record<string, unknown>) => {
    h.comparisons.push(input);
    return input;
  }),
}));

// Durable intent persistence has its own focused tests; these orchestration
// tests keep the broker boundary lightweight while preserving state changes.
vi.mock("../modules/trading/execution-intent.js", () => ({
  prepareDurableExecution: vi.fn(async ({ proposal, mode, explanation, existingTradeId }: any) => {
    const trade = existingTradeId
      ? { id: existingTradeId, symbol: proposal.symbol, lots: proposal.lots, status: "SUBMITTING", explanation }
      : { id: `t${h.created.length + 1}`, symbol: proposal.symbol, lots: proposal.lots, status: "SUBMITTING", mode, explanation };
    if (existingTradeId) h.updated.push(trade); else h.created.push(trade);
    return { trade, intent: { id: `i-${trade.id}`, clientOrderId: `mt5b-${trade.id}` }, request: { ...proposal, volume: proposal.lots, client_order_id: `mt5b-${trade.id}` } };
  }),
  markIntentSubmitting: vi.fn(async () => {}),
  markIntentUnknown: vi.fn(async () => {}),
  applyOrderResult: vi.fn(async (_intentId: string, tradeId: string, result: any) => {
    const status = result.status ?? (result.ok ? "FILLED" : "REJECTED");
    const trade = { id: tradeId, status: status === "FILLED" ? "EXECUTED" : "FAILED", mt5Ticket: result.position_id ?? result.ticket ?? null, entryPrice: result.price };
    h.updated.push(trade);
    return { intent: { id: _intentId, status }, trade };
  }),
}));

vi.mock("../modules/notifications/service.js", () => ({
  notify: vi.fn(async (_u: string, type: string, title: string) => { h.notes.push({ type, title }); }),
}));

vi.mock("../modules/ws/hub.js", () => ({
  broadcast: vi.fn((event: string) => { h.broadcasts.push({ event }); }),
}));

const { evaluateAndMaybeTrade, executeTrade, decideTrade, enforceEquityGuardian } = await import("../modules/trading/service.js");

const user = { id: "u1", email: "u@x.com", role: "ADMIN", liveTradingEnabled: false } as never;
const strategy = { id: "s1", config: strategyConfig, user } as never;

beforeEach(() => {
  Object.assign(h, {
    botState: { status: "running", mode: "AUTO", emergencyStop: false, demoMode: true, liveTradingEnabled: false, paperForward: false },
    account: { login: "100", balance: 10000, equity: 10000, margin: 0, free_margin: 10000, margin_level: 5000, currency: "USD", is_demo: true },
    positions: [], order: { ok: true, ticket: "ord1", position_id: "pos1", price: 1.0852 },
    tick: { symbol: "EURUSD", bid: 1.085, ask: 1.0852, spread_points: 2, time: new Date().toISOString() },
    ai: { decision: "buy", confidence: 0.9, reasoning: "ok", risk_level: "low", suggested_stop_loss: null, suggested_take_profit: null, news_risk: "low", should_execute: true },
    aiValid: true, newsAction: "allow", analysisSpread: 2, signalDirection: "buy",
    levels: { entry: 1.0852, stopLoss: 1.0832, takeProfit: 1.0892 }, accountId: null, tradeForDecide: null,
    operational: true, setStateCalls: [], created: [], updated: [], closed: [], notes: [], audits: [], broadcasts: [], incidents: [], orders: [], paperOpened: [], comparisons: [],
  });
  // Completed hourly candles ending one bar before the tick (so the pipeline's
  // bar-checkpoint gate sees a finished primary bar to act on).
  const now = Date.parse(h.tick.time);
  h.candles = Array.from({ length: 8 }, (_, i) => {
    const t = now - (8 - i) * 3600_000;
    return { time: new Date(t).toISOString(), open: 1.085, high: 1.0856, low: 1.0844, close: 1.085, tick_volume: 100 };
  });
});

const statusesCreated = () => h.created.map((t) => t.status);

describe("evaluateAndMaybeTrade — gate ordering", () => {
  it("does nothing under emergency stop", async () => {
    h.botState.emergencyStop = true;
    expect(await evaluateAndMaybeTrade(user, strategy, "EURUSD")).toBeNull();
    expect(h.created).toHaveLength(0);
  });

  it("does nothing when the bot is not running", async () => {
    h.botState.status = "paused";
    expect(await evaluateAndMaybeTrade(user, strategy, "EURUSD")).toBeNull();
  });

  it("fails closed before market access when Redis is unavailable", async () => {
    h.operational = false;
    expect(await evaluateAndMaybeTrade(user, strategy, "EURUSD")).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(h.incidents).toContainEqual(expect.objectContaining({ dedupeKey: "redis:trading-unavailable" }));
  });

  it("vetoes when the AI disagrees with the signal", async () => {
    h.ai.decision = "sell"; // signal is buy
    expect(await evaluateAndMaybeTrade(user, strategy, "EURUSD")).toBeNull();
    expect(h.audits.some((a) => a.action === "ai_veto")).toBe(true);
    expect(h.created).toHaveLength(0);
  });

  it("records ai_unavailable (distinct from a veto) when the model is down", async () => {
    h.aiValid = false;
    expect(await evaluateAndMaybeTrade(user, strategy, "EURUSD")).toBeNull();
    expect(h.audits.some((a) => a.action === "ai_unavailable")).toBe(true);
  });

  it("creates a RISK_BLOCKED trade when the risk engine fails (wide spread)", async () => {
    h.analysisSpread = 50; // > maxSpreadPoints 30
    await evaluateAndMaybeTrade(user, strategy, "EURUSD");
    expect(statusesCreated()).toContain("RISK_BLOCKED");
    expect(h.notes.some((n) => n.type === "risk_violation")).toBe(true);
  });

  it("blocks on a news pause via the risk engine", async () => {
    h.newsAction = "pause";
    await evaluateAndMaybeTrade(user, strategy, "EURUSD");
    expect(statusesCreated()).toContain("RISK_BLOCKED");
  });

  it("MANUAL mode records an ANALYZED recommendation, places no order", async () => {
    h.botState.mode = "MANUAL";
    await evaluateAndMaybeTrade(user, strategy, "EURUSD");
    expect(statusesCreated()).toContain("ANALYZED");
    expect(h.broadcasts.some((b) => b.event === "trade")).toBe(false);
  });

  it("SEMI_AUTO mode creates a PENDING_APPROVAL trade", async () => {
    h.botState.mode = "SEMI_AUTO";
    await evaluateAndMaybeTrade(user, strategy, "EURUSD");
    expect(statusesCreated()).toContain("PENDING_APPROVAL");
    expect(h.broadcasts.some((b) => b.event === "approval_request")).toBe(true);
  });

  it("AUTO mode executes the trade through the broker", async () => {
    h.botState.mode = "AUTO";
    const trade = await evaluateAndMaybeTrade(user, strategy, "EURUSD");
    expect((trade as { status?: string } | null)?.status).toBe("EXECUTED");
    expect(h.audits.some((a) => a.action === "trade_executed")).toBe(true);
    expect(h.comparisons).toHaveLength(1);
  });

  it("paper-forward mode records a paper trade and never calls the broker", async () => {
    h.botState.mode = "AUTO";
    h.botState.paperForward = true;

    const trade = await evaluateAndMaybeTrade(user, strategy, "EURUSD");

    expect((trade as { status?: string } | null)?.status).toBe("OPEN");
    expect(h.paperOpened).toHaveLength(1);
    expect(h.orders).toHaveLength(0);
  });
});

describe("executeTrade", () => {
  const proposal = { symbol: "EURUSD", direction: "buy" as const, lots: 0.1, entry: 1.0852, stopLoss: 1.0832, takeProfit: 1.0892 };

  it("stamps the broker position id (not the order ticket) on a fill", async () => {
    const trade = await executeTrade(user, proposal, { explanation: {}, mode: "AUTO", actor: "test" });
    expect(trade.status).toBe("EXECUTED");
    expect((trade as { mt5Ticket?: string }).mt5Ticket).toBe("pos1"); // position_id, not "ord1"
  });

  it("records a FAILED trade when the broker rejects the order", async () => {
    h.order = { ok: false, error: "rejected" };
    const trade = await executeTrade(user, proposal, { explanation: {}, mode: "AUTO", actor: "test" });
    expect(trade.status).toBe("FAILED");
    expect(h.audits.some((a) => a.action === "trade_failed")).toBe(true);
  });

  it("does not call the broker when operational coordination is unavailable", async () => {
    h.operational = false;
    await expect(executeTrade(user, proposal, { explanation: {}, mode: "AUTO", actor: "test" }))
      .rejects.toThrow("operational trading unavailable");
    expect(h.created).toHaveLength(0);
  });
});

describe("enforceEquityGuardian", () => {
  it("does nothing when equity is above the floor", async () => {
    h.positions = [{ ticket: "p1", symbol: "EURUSD", volume: 0.1, profit: -10 }];
    await enforceEquityGuardian();
    expect(h.closed).toHaveLength(0);
    expect(h.setStateCalls).toHaveLength(0);
  });

  it("flattens all positions and pauses when equity breaches the floor", async () => {
    h.account.equity = 7000; // 70% of balance < 80% floor
    h.positions = [
      { ticket: "p1", symbol: "EURUSD", volume: 0.1, profit: -1500 },
      { ticket: "p2", symbol: "XAUUSD", volume: 0.1, profit: -1500 },
    ];
    await enforceEquityGuardian();
    expect(h.closed).toEqual(["p1", "p2"]);
    expect(h.setStateCalls.some((c) => c.status === "paused")).toBe(true);
    expect(h.audits.some((a) => a.action === "equity_guardian_flatten")).toBe(true);
    expect(h.incidents).toContainEqual(expect.objectContaining({ dedupeKey: "risk:equity-guardian" }));
  });

  it("does not run while the bot is not running (self-limiting)", async () => {
    h.botState.status = "paused";
    h.account.equity = 1000;
    h.positions = [{ ticket: "p1", symbol: "EURUSD", volume: 0.1, profit: -9000 }];
    await enforceEquityGuardian();
    expect(h.closed).toHaveLength(0);
  });
});

describe("decideTrade — approval re-validation", () => {
  const pendingTrade = (overrides: Record<string, unknown> = {}) => ({
    id: "t1", userId: "u1", symbol: "EURUSD", direction: "BUY", lots: 0.1,
    stopLoss: 1.0832, takeProfit: 1.0892, strategyId: "s1", aiAnalysisId: "log1",
    mode: "SEMI_AUTO", explanation: {}, status: "PENDING_APPROVAL", user,
    approval: { id: "a1", expiresAt: new Date(Date.now() + 600000), status: "pending" },
    ...overrides,
  });

  it("rejects cleanly when asked to reject", async () => {
    h.tradeForDecide = pendingTrade();
    const r = await decideTrade("t1", false, "tester", "DASHBOARD", { actorUserId: "u1" });
    expect(r.ok).toBe(true);
    expect(h.updated.some((t) => t.status === "REJECTED")).toBe(true);
  });

  it("cancels an expired approval instead of executing", async () => {
    h.tradeForDecide = pendingTrade({ approval: { id: "a1", expiresAt: new Date(Date.now() - 1000), status: "pending" } });
    const r = await decideTrade("t1", true, "tester", "DASHBOARD", { actorUserId: "u1" });
    expect(r.ok).toBe(false);
    expect(h.updated.some((t) => t.status === "CANCELLED")).toBe(true);
  });

  it("executes on approval when the fresh risk re-check passes", async () => {
    h.tradeForDecide = pendingTrade();
    const r = await decideTrade("t1", true, "tester", "DASHBOARD", { actorUserId: "u1" });
    expect(r.ok).toBe(true);
    expect(h.audits.some((a) => a.action === "trade_executed")).toBe(true);
  });

  it("blocks on approval when the fresh risk re-check fails (wide spread)", async () => {
    h.tradeForDecide = pendingTrade();
    h.tick = { ...h.tick, spread_points: 50 };
    const r = await decideTrade("t1", true, "tester", "DASHBOARD", { actorUserId: "u1" });
    expect(r.ok).toBe(false);
    expect(h.updated.some((t) => t.status === "RISK_BLOCKED")).toBe(true);
  });

  it("does not let another user decide the trade", async () => {
    h.tradeForDecide = pendingTrade();
    const r = await decideTrade("t1", true, "tester", "DASHBOARD", { actorUserId: "other-user" });
    expect(r.ok).toBe(false);
    expect(h.orders).toHaveLength(0);
  });

  it("submits at most one order when an approval is repeated", async () => {
    h.tradeForDecide = pendingTrade();
    const first = await decideTrade("t1", true, "tester", "DASHBOARD", { actorUserId: "u1" });
    const second = await decideTrade("t1", true, "tester", "DASHBOARD", { actorUserId: "u1" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(h.orders).toHaveLength(1);
  });
});
