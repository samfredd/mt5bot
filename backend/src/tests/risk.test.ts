import { describe, expect, it } from "vitest";
import { calculateLots, validateTrade, type RiskContext, type TradeProposal } from "../modules/risk/engine.js";

const settings = {
  id: "rs1", userId: "u1",
  maxRiskPerTradePct: 1, maxDailyLossPct: 3, maxWeeklyLossPct: 6, maxDrawdownPct: 10,
  maxOpenTrades: 5, maxTradesPerSymbol: 2, maxTradesPerDay: 10, maxLotSize: 0.5,
  minRiskReward: 1.5, requireStopLoss: true, requireTakeProfit: false,
  maxSpreadPoints: 30, maxAtrVolatilityPct: 3, newsRiskLimit: "MEDIUM" as const,
  pauseBeforeNewsMin: 30, pauseAfterNewsMin: 30, allowNewsTrading: false,
  allowedSessions: ["london", "newyork"] as unknown as object,
  equityProtectionPct: 80, copyExposureLimitPct: 20, maxDailyCopiedTrades: 10,
  maxConsecutiveLosses: 3,
};

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    settings: settings as RiskContext["settings"],
    account: { balance: 10000, equity: 10000, margin_level: 5000 },
    openPositions: [], tradesToday: 0, copiedTradesToday: 0, consecutiveLosses: 0,
    dailyPnl: 0, weeklyPnl: 0, peakEquity: 10000,
    spreadPoints: 10, atrPct: 0.5, session: "london", newsAction: "allow",
    emergencyStop: false, botRunning: true,
    isLiveAccount: false, liveTradingEnabled: false, userLiveEnabled: false,
    twoFactorVerified: false, accountVerified: true,
    ...overrides,
  };
}

const goodTrade: TradeProposal = {
  symbol: "EURUSD", direction: "buy", lots: 0.1,
  entry: 1.085, stopLoss: 1.0825, takeProfit: 1.09,
};

describe("risk engine", () => {
  it("passes a sane demo trade", () => {
    const r = validateTrade(goodTrade, ctx());
    expect(r.checks.filter((c) => !c.passed)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("blocks everything under emergency stop", () => {
    const r = validateTrade(goodTrade, ctx({ emergencyStop: true }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "emergency_stop")?.passed).toBe(false);
  });

  it("blocks when the bot is not running", () => {
    expect(validateTrade(goodTrade, ctx({ botRunning: false })).ok).toBe(false);
  });

  it("requires a stop-loss", () => {
    const r = validateTrade({ ...goodTrade, stopLoss: null }, ctx());
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "stop_loss_required")?.passed).toBe(false);
  });

  it("rejects a stop-loss on the wrong side", () => {
    const r = validateTrade({ ...goodTrade, stopLoss: 1.09 }, ctx());
    expect(r.checks.find((c) => c.name === "stop_loss_direction")?.passed).toBe(false);
  });

  it("enforces minimum risk:reward", () => {
    // risk 25 pips, reward 10 pips → R:R 0.4 < 1.5
    const r = validateTrade({ ...goodTrade, takeProfit: 1.086 }, ctx());
    expect(r.checks.find((c) => c.name === "min_risk_reward")?.passed).toBe(false);
  });

  it("enforces lot size cap", () => {
    expect(validateTrade({ ...goodTrade, lots: 5 }, ctx()).ok).toBe(false);
  });

  it("stops trading after a losing streak (circuit breaker)", () => {
    const r = validateTrade(goodTrade, ctx({ consecutiveLosses: 3 }));
    expect(r.checks.find((c) => c.name === "max_consecutive_losses")?.passed).toBe(false);
    expect(validateTrade(goodTrade, ctx({ consecutiveLosses: 2 })).ok).toBe(true);
  });

  it("blocks on daily loss limit", () => {
    const r = validateTrade(goodTrade, ctx({ dailyPnl: -400 })); // 4% > 3%
    expect(r.checks.find((c) => c.name === "max_daily_loss")?.passed).toBe(false);
  });

  it("blocks on drawdown from peak equity", () => {
    const r = validateTrade(goodTrade, ctx({ peakEquity: 12000, account: { balance: 10000, equity: 10500, margin_level: 5000 } }));
    expect(r.checks.find((c) => c.name === "max_drawdown")?.passed).toBe(false);
  });

  it("blocks when spread is too wide", () => {
    expect(validateTrade(goodTrade, ctx({ spreadPoints: 50 })).ok).toBe(false);
  });

  it("blocks during paused news windows", () => {
    const r = validateTrade(goodTrade, ctx({ newsAction: "pause" }));
    expect(r.checks.find((c) => c.name === "news")?.passed).toBe(false);
  });

  it("halves lots when news says reduce", () => {
    const r = validateTrade(goodTrade, ctx({ newsAction: "reduce" }));
    expect(r.adjustedLots).toBeCloseTo(0.05);
  });

  it("blocks outside allowed sessions", () => {
    expect(validateTrade(goodTrade, ctx({ session: "asia" })).ok).toBe(false);
  });

  it("blocks at open-trade caps", () => {
    const pos = { symbol: "EURUSD", volume: 0.1, profit: 0 };
    expect(validateTrade(goodTrade, ctx({ openPositions: [pos, pos, pos, pos, pos] })).ok).toBe(false);
    expect(validateTrade(goodTrade, ctx({ openPositions: [pos, pos] })).checks.find((c) => c.name === "max_trades_per_symbol")?.passed).toBe(false);
  });

  describe("live trading gates", () => {
    const live = { isLiveAccount: true };
    it("blocks live trades when the platform kill switch is off", () => {
      const r = validateTrade(goodTrade, ctx({ ...live, userLiveEnabled: true, twoFactorVerified: true }));
      expect(r.checks.find((c) => c.name === "live_env_enabled")?.passed).toBe(false);
    });
    it("blocks live trades without user opt-in", () => {
      const r = validateTrade(goodTrade, ctx({ ...live, liveTradingEnabled: true, twoFactorVerified: true }));
      expect(r.checks.find((c) => c.name === "live_user_enabled")?.passed).toBe(false);
    });
    it("blocks live trades without 2FA", () => {
      const r = validateTrade(goodTrade, ctx({ ...live, liveTradingEnabled: true, userLiveEnabled: true }));
      expect(r.checks.find((c) => c.name === "live_2fa")?.passed).toBe(false);
    });
    it("allows live trades only with every gate open", () => {
      const r = validateTrade(goodTrade, ctx({ ...live, liveTradingEnabled: true, userLiveEnabled: true, twoFactorVerified: true, accountVerified: true }));
      expect(r.ok).toBe(true);
    });
  });

  describe("copy trade limits", () => {
    it("enforces daily copied-trade cap", () => {
      const r = validateTrade({ ...goodTrade, isCopyTrade: true }, ctx({ copiedTradesToday: 10 }));
      expect(r.checks.find((c) => c.name === "max_daily_copied_trades")?.passed).toBe(false);
    });
  });
});

describe("calculateLots", () => {
  it("sizes position from risk percentage", () => {
    // 1% of 10k = $100 risk; 25 pip SL on EURUSD → 100/(0.0025*100000) = 0.4
    expect(calculateLots(10000, 1, 1.085, 1.0825, 0.5)).toBeCloseTo(0.4);
  });
  it("caps at max lot", () => {
    expect(calculateLots(1000000, 5, 1.085, 1.0825, 0.5)).toBe(0.5);
  });
  it("floors at 0.01", () => {
    expect(calculateLots(100, 0.1, 1.085, 1.0825, 0.5)).toBe(0.01);
  });
});
