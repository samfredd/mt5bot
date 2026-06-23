import { describe, expect, it } from "vitest";
import { ScalpingRiskSchema, ScalpingConfigSchema } from "../modules/scalping/scalping.schema.js";
import {
  aiPermitsFire, currencyExposureWouldExceed, dailyLossExceeded, evaluateScalpingGate,
  hasActiveScalpForSymbol, lossStreakPauseUntil, profitTargetReached, reentryCooldownRemainingMs,
  scalpExitReason, sessionAllowed, totalExposureExceedsCap, withinMaxTotal, type ScalpGateInput,
} from "../modules/scalping/scalping.risk.js";
import { isScalpingTrade, SCALPING_SOURCE, type ScalpingAiDecision } from "../modules/scalping/scalping.types.js";
import { moneyDerivedStops, pointsDerivedStops, riskBasedLotSize, signedPointsMoved, scalpLotSize, scalpingPreflightBlockReason } from "../modules/scalping/scalping.service.js";
import { normalizeLegacyScalpingRisk } from "../modules/scalping/scalping.state.js";
import { maybeScalpingBlockAudit } from "../modules/scalping/scalping.worker.js";
import { SCALPING_PRESETS, detectPreset, exposureCapPct, totalExposureExceedsCapForRisk } from "../modules/scalping/scalping.presets.js";
import { fallbackTradingSpec, moneyForPriceMove, priceDistanceFromPoints } from "../modules/risk/instruments.js";

const RISK = ScalpingRiskSchema.parse({});
const CONFIG = ScalpingConfigSchema.parse({});

function ai(overrides: Partial<ScalpingAiDecision> = {}): ScalpingAiDecision {
  return {
    symbol: "EURUSD", decision: "buy", confidence: 0.8, riskLevel: "low", shouldExecute: false,
    reasoning: "test", validUntil: new Date(Date.now() + 60_000).toISOString(), aiDecisionId: "log1", valid: true,
    ...overrides,
  };
}

function gateInput(overrides: Partial<ScalpGateInput> = {}): ScalpGateInput {
  return {
    config: { ...CONFIG, status: "running", enabled: true },
    risk: RISK,
    symbol: "EURUSD",
    direction: "buy",
    globalEmergencyStop: false,
    redisAvailable: true,
    active: [],
    tradesToday: 0,
    lastClosedForSymbol: null,
    recentClosedDesc: [],
    todayNetProfit: 0,
    balance: 500,
    spreadPoints: 10,
    session: "london",
    newsAction: "allow",
    ai: ai(),
    now: Date.now(),
    ...overrides,
  };
}

describe("scalping risk settings validation", () => {
  it("rejects maxOpenTradesTotal outside 1..10", () => {
    expect(ScalpingRiskSchema.safeParse({ maxOpenTradesTotal: 0 }).success).toBe(false);
    expect(ScalpingRiskSchema.safeParse({ maxOpenTradesTotal: 11 }).success).toBe(false);
    expect(ScalpingRiskSchema.safeParse({ maxOpenTradesTotal: 5 }).success).toBe(true);
  });

  it("rejects maxTradesPerSymbol > 1 in v1", () => {
    expect(ScalpingRiskSchema.safeParse({ maxTradesPerSymbol: 2 }).success).toBe(false);
    expect(ScalpingRiskSchema.safeParse({ maxTradesPerSymbol: 1 }).success).toBe(true);
  });

  it("rejects non-positive money targets and sub-1s re-entry", () => {
    expect(ScalpingRiskSchema.safeParse({ targetProfitMoney: 0 }).success).toBe(false);
    expect(ScalpingRiskSchema.safeParse({ maxLossMoney: -1 }).success).toBe(false);
    expect(ScalpingRiskSchema.safeParse({ reentryAfterWinSeconds: 0 }).success).toBe(false);
    expect(ScalpingRiskSchema.safeParse({ reentryAfterLossSeconds: 0 }).success).toBe(false);
  });

  it("rejects minAiConfidence outside 0..1 and an unrealistic daily loss cap", () => {
    expect(ScalpingConfigSchema.safeParse({ minAiConfidence: 1.5 }).success).toBe(false);
    expect(ScalpingRiskSchema.safeParse({ dailyLossLimitPercent: 99 }).success).toBe(false);
    expect(ScalpingRiskSchema.safeParse({ dailyLossLimitPercent: 1.5 }).success).toBe(true);
  });

  it("applies documented defaults", () => {
    expect(RISK.maxOpenTradesTotal).toBe(5);
    expect(RISK.maxTradesPerSymbol).toBe(1);
    expect(RISK.targetProfitMoney).toBeCloseTo(0.2);
    expect(RISK.maxLossMoney).toBeCloseTo(0.05);
    expect(RISK.maxLotSize).toBeCloseTo(0.01);
    expect(RISK.stopBasis).toBe("money");
    expect(RISK.takeProfitPoints).toBeNull();
    expect(RISK.stopLossPoints).toBeNull();
    expect(RISK.profitTargetMoney).toBeNull();
    expect(RISK.pauseBeforeNewsMin).toBe(15);
    expect(RISK.pauseAfterNewsMin).toBe(5);
    expect(RISK.newsRiskLimit).toBe("HIGH");
    expect(CONFIG.minAiConfidence).toBeCloseTo(0.72);
  });
});

describe("one-trade-per-symbol enforcement", () => {
  it("blocks a second trade on the same pair (suffix-tolerant)", () => {
    expect(hasActiveScalpForSymbol([{ symbol: "EURUSDm", ticket: "1" }], "EURUSD")).toBe(true);
    expect(hasActiveScalpForSymbol([{ symbol: "GBPUSD", ticket: "1" }], "EURUSD")).toBe(false);
    const gate = evaluateScalpingGate(gateInput({ active: [{ symbol: "EURUSD", ticket: "1" }] }));
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("one_per_symbol");
  });
});

describe("max total open trades enforcement", () => {
  it("withinMaxTotal compares strictly", () => {
    expect(withinMaxTotal(4, 5)).toBe(true);
    expect(withinMaxTotal(5, 5)).toBe(false);
  });
  it("blocks once five different pairs are open", () => {
    const active = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"].map((s, i) => ({ symbol: s, ticket: String(i) }));
    const gate = evaluateScalpingGate(gateInput({ symbol: "NZDUSD", active, config: { ...CONFIG, status: "running", enabled: true, symbols: [...CONFIG.symbols, "NZDUSD"] } }));
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("max_open_total");
  });
});

describe("re-entry cooldown after win/loss", () => {
  const now = Date.now();
  it("allows fast re-entry after a win (1s)", () => {
    expect(reentryCooldownRemainingMs({ symbol: "EURUSD", profit: 0.2, closedAt: new Date(now - 2_000) }, RISK, now)).toBe(0);
    // within the 1s window → still blocked
    expect(reentryCooldownRemainingMs({ symbol: "EURUSD", profit: 0.2, closedAt: new Date(now - 500) }, RISK, now)).toBeGreaterThan(0);
  });
  it("enforces the longer cooldown after a loss (60s)", () => {
    expect(reentryCooldownRemainingMs({ symbol: "EURUSD", profit: -0.05, closedAt: new Date(now - 10_000) }, RISK, now)).toBeGreaterThan(0);
    expect(reentryCooldownRemainingMs({ symbol: "EURUSD", profit: -0.05, closedAt: new Date(now - 61_000) }, RISK, now)).toBe(0);
  });
  it("treats unreconciled (null profit) as the conservative loss-side wait", () => {
    expect(reentryCooldownRemainingMs({ symbol: "EURUSD", profit: null, closedAt: new Date(now - 10_000) }, RISK, now)).toBeGreaterThan(0);
  });
});

describe("AI fire control", () => {
  it("STRICT blocks on low confidence", () => {
    expect(aiPermitsFire(ai({ confidence: 0.6 }), "buy", { ...CONFIG, aiMode: "STRICT" }).ok).toBe(false);
    expect(aiPermitsFire(ai({ confidence: 0.8 }), "buy", { ...CONFIG, aiMode: "STRICT" }).ok).toBe(true);
  });
  it("STRICT blocks on direction mismatch and fails closed when AI invalid", () => {
    expect(aiPermitsFire(ai({ decision: "sell", confidence: 0.9 }), "buy", { ...CONFIG, aiMode: "STRICT" }).ok).toBe(false);
    expect(aiPermitsFire(ai({ valid: false }), "buy", { ...CONFIG, aiMode: "STRICT" }).ok).toBe(false);
    expect(aiPermitsFire(null, "buy", { ...CONFIG, aiMode: "STRICT" }).ok).toBe(false);
  });
  it("ADVISORY logs but allows a normal low-confidence case, blocking only strong avoid/high risk", () => {
    expect(aiPermitsFire(ai({ confidence: 0.4 }), "buy", { ...CONFIG, aiMode: "ADVISORY" }).ok).toBe(true);
    expect(aiPermitsFire(ai({ decision: "avoid" }), "buy", { ...CONFIG, aiMode: "ADVISORY" }).ok).toBe(false);
    expect(aiPermitsFire(ai({ riskLevel: "high" }), "buy", { ...CONFIG, aiMode: "ADVISORY" }).ok).toBe(false);
  });
  it("PURE_LOGIC always permits — no AI, even with a missing or hostile decision", () => {
    const pure = { ...CONFIG, useAiFireControl: true, aiMode: "PURE_LOGIC" as const };
    expect(aiPermitsFire(null, "buy", pure).ok).toBe(true);
    expect(aiPermitsFire(ai({ decision: "avoid", riskLevel: "high" }), "buy", pure).ok).toBe(true);
    expect(aiPermitsFire(ai({ decision: "sell", confidence: 0.99 }), "buy", pure).ok).toBe(true);
  });
});

describe("per-trade exit basis", () => {
  it("money basis closes on the $ target / max loss", () => {
    const r = { ...RISK, stopBasis: "money" as const, targetProfitMoney: 0.2, maxLossMoney: 0.05 };
    expect(scalpExitReason({ profit: 0.2, pointsMoved: null }, r)).toBe("SCALP_TP_MONEY");
    expect(scalpExitReason({ profit: -0.05, pointsMoved: null }, r)).toBe("SCALP_MAX_LOSS_MONEY");
    expect(scalpExitReason({ profit: 0.1, pointsMoved: null }, r)).toBeNull();
  });
  it("points basis closes on the configured point move, ignoring floating $", () => {
    const r = { ...RISK, stopBasis: "points" as const, takeProfitPoints: 30, stopLossPoints: 20 };
    expect(scalpExitReason({ profit: -99, pointsMoved: 30 }, r)).toBe("SCALP_TP_MONEY");
    expect(scalpExitReason({ profit: 99, pointsMoved: -20 }, r)).toBe("SCALP_MAX_LOSS_MONEY");
    expect(scalpExitReason({ profit: 0, pointsMoved: 10 }, r)).toBeNull();
  });
  it("points basis falls back to money when points are unset or move is unknown", () => {
    const noPoints = { ...RISK, stopBasis: "points" as const, takeProfitPoints: null, stopLossPoints: null, targetProfitMoney: 0.2, maxLossMoney: 0.05 };
    expect(scalpExitReason({ profit: 0.2, pointsMoved: null }, noPoints)).toBe("SCALP_TP_MONEY");
    const noMove = { ...RISK, stopBasis: "points" as const, takeProfitPoints: 30, stopLossPoints: 20, targetProfitMoney: 0.2, maxLossMoney: 0.05 };
    expect(scalpExitReason({ profit: 0.2, pointsMoved: null }, noMove)).toBe("SCALP_TP_MONEY");
  });
  it("signedPointsMoved is positive when a position is in profit (both directions)", () => {
    const spec = fallbackTradingSpec("EURUSD", 1.1);
    expect(signedPointsMoved({ type: "buy", price_open: 1.10000, price_current: 1.10000 + spec.point * 25 }, spec.point)).toBeCloseTo(25);
    expect(signedPointsMoved({ type: "sell", price_open: 1.10000, price_current: 1.10000 - spec.point * 25 }, spec.point)).toBeCloseTo(25);
  });
  it("pointsDerivedStops places TP/SL the right side of entry", () => {
    const spec = fallbackTradingSpec("EURUSD", 1.1);
    const buy = pointsDerivedStops("buy", 1.10000, spec, 30, 20, 5);
    expect(buy.takeProfit).toBeGreaterThan(1.10000);
    expect(buy.stopLoss).toBeLessThan(1.10000);
    const sell = pointsDerivedStops("sell", 1.10000, spec, 30, 20, 5);
    expect(sell.takeProfit).toBeLessThan(1.10000);
    expect(sell.stopLoss).toBeGreaterThan(1.10000);
  });
});

describe("session profit goal", () => {
  it("reached only when a goal is set and net meets it", () => {
    expect(profitTargetReached(0.05, null)).toBe(false);
    expect(profitTargetReached(0.04, 0.05)).toBe(false);
    expect(profitTargetReached(0.05, 0.05)).toBe(true);
    expect(profitTargetReached(1.0, 0.05)).toBe(true);
  });
  it("blocks new entries at the gate once the goal is hit", () => {
    const risk = { ...RISK, profitTargetMoney: 0.05 };
    expect(evaluateScalpingGate(gateInput({ risk, todayNetProfit: 0.05 })).reason).toContain("profit_target");
    expect(evaluateScalpingGate(gateInput({ risk, todayNetProfit: 0.04 })).ok).toBe(true);
  });
});

describe("scalping-owned risk settings", () => {
  it("uses scalping spread settings instead of global spread caps", () => {
    const spec = fallbackTradingSpec("EURUSD", 1.1);
    const lots = scalpLotSize(spec, RISK.maxLotSize);
    const stops = moneyDerivedStops("buy", 1.1, lots, spec, 0.2, 0.05, 5)!;
    const gate = evaluateScalpingGate(gateInput({
      symbol: "EURUSD",
      spreadPoints: 14,
      risk: { ...RISK, maxSpreadPointsBySymbol: { EURUSD: 15 } },
    }));

    expect(stops).not.toBeNull();
    expect(gate.ok).toBe(true);
  });
});

describe("scalping trades are tagged separately from normal trades", () => {
  it("isScalpingTrade only matches the scalping source tag", () => {
    expect(isScalpingTrade({ source: SCALPING_SOURCE })).toBe(true);
    // a normal scanner trade explanation must NOT be picked up as scalping
    expect(isScalpingTrade({ scanner: true })).toBe(false);
    expect(isScalpingTrade({ strategy: { name: "Trend Follower" } })).toBe(false);
    expect(isScalpingTrade(null)).toBe(false);
  });
});

describe("supporting gate logic", () => {
  it("currency exposure cap counts shared currencies", () => {
    // EUR already in two active pairs → a third EUR pair exceeds the cap of 2.
    expect(currencyExposureWouldExceed(["EURUSD", "EURGBP"], "EURJPY", 2)).toBe(true);
    expect(currencyExposureWouldExceed(["EURUSD"], "GBPJPY", 2)).toBe(false);
  });
  it("daily loss limit trips on percent of balance", () => {
    expect(dailyLossExceeded(-10, 500, { dailyLossLimitMoney: null, dailyLossLimitPercent: 1.5 })).toBe(true); // 2% > 1.5%
    expect(dailyLossExceeded(-5, 500, { dailyLossLimitMoney: null, dailyLossLimitPercent: 1.5 })).toBe(false); // 1% < 1.5%
  });
  it("session allow-list canonicalizes the engine overlap label", () => {
    expect(sessionAllowed("london_newyork_overlap", ["london", "newyork_overlap"])).toBe(true);
    expect(sessionAllowed("sydney", ["london", "newyork_overlap"])).toBe(false);
  });
  it("treats the London/NY overlap as allowed when either parent session is allowed", () => {
    // The bug: allowing london+newyork blocked the overlap between them.
    expect(sessionAllowed("london_newyork_overlap", ["london", "newyork"])).toBe(true);
    expect(sessionAllowed("london_newyork_overlap", ["newyork"])).toBe(true);
    expect(sessionAllowed("london_newyork_overlap", ["london"])).toBe(true);
    // ...but allowing ONLY the overlap (Low preset) still excludes plain sessions.
    expect(sessionAllowed("london", ["newyork_overlap"])).toBe(false);
    expect(sessionAllowed("newyork", ["newyork_overlap"])).toBe(false);
    expect(sessionAllowed("asian", ["london", "newyork"])).toBe(false);
  });
  it("allows the New York session by default", () => {
    expect(evaluateScalpingGate(gateInput({ session: "newyork" })).ok).toBe(true);
  });
  it("explains scalping preflight blocks instead of silently no-oping", () => {
    expect(scalpingPreflightBlockReason({ status: "running", enabled: true, emergencyStop: false, redisOk: false }))
      .toBe("redis unavailable — fail closed");
    expect(scalpingPreflightBlockReason({ status: "paused", enabled: true, emergencyStop: false, redisOk: true }))
      .toBe("scalping paused");
    expect(scalpingPreflightBlockReason({ status: "running", enabled: true, emergencyStop: false, redisOk: true }))
      .toBeNull();
  });
  it("allows manual run-once preflight when scalping is enabled but paused", () => {
    expect(scalpingPreflightBlockReason(
      { status: "paused", enabled: true, emergencyStop: false, redisOk: true },
      { requireRunning: false },
    )).toBeNull();
    expect(scalpingPreflightBlockReason(
      { status: "stopped", enabled: false, emergencyStop: false, redisOk: true },
      { requireRunning: false },
    )).toBe("scalping disabled");
  });
  it("upgrades the old default session list to include New York", () => {
    expect(normalizeLegacyScalpingRisk({ allowedSessions: ["london", "newyork_overlap"] }).allowedSessions)
      .toEqual(["london", "newyork", "newyork_overlap"]);
    expect(normalizeLegacyScalpingRisk({ allowedSessions: ["london"] }).allowedSessions)
      .toEqual(["london"]);
  });
  it("loss-streak pause is time-boxed from the last loss", () => {
    const now = Date.now();
    const threeLosses = [
      { symbol: "EURUSD", profit: -0.05, closedAt: new Date(now - 60_000) },
      { symbol: "GBPUSD", profit: -0.05, closedAt: new Date(now - 120_000) },
      { symbol: "USDJPY", profit: -0.05, closedAt: new Date(now - 180_000) },
    ];
    // pause window is 10 min from the most recent loss → still paused at 1 min
    expect(lossStreakPauseUntil(threeLosses, RISK, now)).not.toBeNull();
    // after the window has elapsed → released
    expect(lossStreakPauseUntil(threeLosses, RISK, now + 11 * 60_000)).toBeNull();
  });
});

describe("automatic scalping entry telemetry", () => {
  it("audits a blocked auto-entry reason without spamming the same reason every tick", () => {
    const blocked = {
      opened: [],
      blocked: [{ symbol: "USDJPY", reason: "global risk: exposure: USD net exposure exceeds cap" }],
      skipped: 2,
    };

    const first = maybeScalpingBlockAudit(blocked, null, 1_000);
    expect(first.event?.detail).toMatchObject({
      symbol: "USDJPY",
      reason: "global risk: exposure: USD net exposure exceeds cap",
      blockedCount: 1,
      skipped: 2,
    });

    const repeated = maybeScalpingBlockAudit(blocked, first.state, 5_000);
    expect(repeated.event).toBeNull();

    const afterThrottle = maybeScalpingBlockAudit(blocked, first.state, 32_000);
    expect(afterThrottle.event?.detail.reason).toContain("global risk");

    const changedReason = maybeScalpingBlockAudit({
      opened: [],
      blocked: [{ symbol: "USDJPY", reason: "scalp_spread: spread 42 pts" }],
      skipped: 2,
    }, first.state, 6_000);
    expect(changedReason.event?.detail.reason).toContain("scalp_spread");
  });

  it("does not emit blocked telemetry when a scalp opened", () => {
    const result = maybeScalpingBlockAudit({
      opened: [{ symbol: "USDJPY", direction: "buy", ticket: "123" }],
      blocked: [{ symbol: "AUDUSD", reason: "max_open_total: 5/5 open" }],
      skipped: 0,
    }, null, 1_000);

    expect(result.event).toBeNull();
  });
});

describe("scalping risk presets", () => {
  const applied = (key: "low" | "medium" | "aggressive") => ({
    config: { ...CONFIG, ...SCALPING_PRESETS[key].config },
    risk: { ...RISK, ...SCALPING_PRESETS[key].risk },
  });

  it("applies the spec'd values for each preset", () => {
    expect(SCALPING_PRESETS.low.risk.riskPerTradePercent).toBe(0.25);
    expect(SCALPING_PRESETS.low.risk.maxOpenTradesTotal).toBe(2);
    expect(SCALPING_PRESETS.low.config.minAiConfidence).toBe(0.82);
    expect(SCALPING_PRESETS.medium.risk.riskPerTradePercent).toBe(0.5);
    expect(SCALPING_PRESETS.aggressive.risk.riskPerTradePercent).toBe(1.0);
    expect(SCALPING_PRESETS.aggressive.risk.maxOpenTradesTotal).toBe(5);
    // every preset uses risk-based sizing off a points stop
    for (const key of ["low", "medium", "aggressive"] as const) {
      expect(SCALPING_PRESETS[key].risk.lotMode).toBe("risk_percent");
      expect(SCALPING_PRESETS[key].risk.stopBasis).toBe("points");
      expect(SCALPING_PRESETS[key].risk.stopLossPoints).toBeGreaterThan(0);
    }
  });

  it("detectPreset round-trips each applied preset", () => {
    for (const key of ["low", "medium", "aggressive"] as const) {
      const { config, risk } = applied(key);
      expect(detectPreset(config, risk)).toBe(key);
    }
  });

  it("a manual edit to any preset value flips it to custom", () => {
    const { config, risk } = applied("medium");
    expect(detectPreset(config, { ...risk, maxOpenTradesTotal: 99 })).toBe("custom");
    expect(detectPreset(config, { ...risk, riskPerTradePercent: 0.9 })).toBe("custom");
    expect(detectPreset({ ...config, minAiConfidence: 0.5 }, risk)).toBe("custom");
  });

  it("the default (hand-tuned) config is custom", () => {
    expect(detectPreset(CONFIG, RISK)).toBe("custom");
  });
});

describe("exposure caps (aggressive is not reckless)", () => {
  it("worst-case open risk stays within each preset cap", () => {
    expect(totalExposureExceedsCap(2, 0.25, 1)).toBe(false); // low 0.5% <= 1%
    expect(totalExposureExceedsCap(3, 0.5, 2)).toBe(false);  // medium 1.5% <= 2%
    expect(totalExposureExceedsCap(5, 1.0, 5)).toBe(false);  // aggressive 5% == 5%
    expect(totalExposureExceedsCap(6, 1.0, 5)).toBe(true);   // over the ceiling
  });

  it("every shipped preset respects its own cap", () => {
    for (const key of ["low", "medium", "aggressive"] as const) {
      const r = SCALPING_PRESETS[key].risk;
      expect(totalExposureExceedsCapForRisk({
        lotMode: "risk_percent", scalpingRiskPreset: key,
        maxOpenTradesTotal: r.maxOpenTradesTotal!, riskPerTradePercent: r.riskPerTradePercent!,
      })).toBe(false);
      expect(r.maxOpenTradesTotal! * r.riskPerTradePercent!).toBeLessThanOrEqual(exposureCapPct(key));
    }
  });

  it("fixed-lot mode is never exposure-capped (existing configs untouched)", () => {
    expect(totalExposureExceedsCapForRisk({ lotMode: "fixed", scalpingRiskPreset: "custom", maxOpenTradesTotal: 10, riskPerTradePercent: 5 })).toBe(false);
  });

  it("the entry gate blocks when total exposure exceeds the cap", () => {
    const risk = { ...RISK, lotMode: "risk_percent" as const, scalpingRiskPreset: "custom" as const, maxOpenTradesTotal: 10, riskPerTradePercent: 1 };
    expect(evaluateScalpingGate(gateInput({ risk })).reason).toContain("exposure_cap");
  });
});

describe("risk-based lot sizing", () => {
  const spec = fallbackTradingSpec("EURUSD", 1.1);
  const sl = 50;
  const riskAt = (lots: number) => moneyForPriceMove(priceDistanceFromPoints(sl, spec), lots, spec);

  it("scales with balance and never drops below the broker minimum", () => {
    const l500 = riskBasedLotSize(500, 0.5, sl, spec, 1_000);
    const l1000 = riskBasedLotSize(1_000, 0.5, sl, spec, 1_000);
    const l5000 = riskBasedLotSize(5_000, 0.5, sl, spec, 1_000);
    expect(l500).toBeGreaterThanOrEqual(spec.volumeMin);
    expect(l1000).toBeGreaterThan(l500);
    expect(l5000).toBeGreaterThan(l1000);
  });

  it("keeps realized risk within target (+ one lot-step), never blindly oversized", () => {
    for (const balance of [500, 1_000, 5_000]) {
      const lots = riskBasedLotSize(balance, 0.5, sl, spec, 1_000);
      const target = balance * 0.5 / 100;
      // floored to the step, so risk is at most the target plus one step of risk
      expect(riskAt(lots)).toBeLessThanOrEqual(target + riskAt(spec.volumeStep) + 1e-9);
    }
    // aggressive on a $500 account stays modest, not 0.10+ blindly
    expect(riskBasedLotSize(500, 1.0, 60, spec, 1_000)).toBeLessThan(0.2);
  });

  it("falls back to the fixed minimum lot when the stop can't be priced", () => {
    expect(riskBasedLotSize(0, 0.5, sl, spec, 1_000)).toBe(scalpLotSize(spec, 1_000));
    expect(riskBasedLotSize(500, 0.5, 0, spec, 1_000)).toBe(scalpLotSize(spec, 1_000));
  });
});
