import { describe, expect, it } from "vitest";
import { adaptiveRiskSettings, applyAiLotSizing } from "../modules/risk/adaptive.js";
import type { RiskSettings } from "@prisma/client";

const settings = {
  maxRiskPerTradePct: 2,
  maxLotSize: 1,
  maxOpenTrades: 8,
  maxTradesPerSymbol: 4,
  maxTradesPerDay: 20,
} as RiskSettings;

const instrument = {
  symbol: "EURUSD", digits: 5, point: 0.00001, tickSize: 0.00001,
  tickValue: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, stopsLevelPoints: 0,
};

describe("adaptive capital risk", () => {
  it("caps a micro account below the stored user ceilings", () => {
    const result = adaptiveRiskSettings(settings, 433, true);
    expect(result.profile.tier).toBe("micro");
    expect(result.settings.maxRiskPerTradePct).toBe(0.25);
    expect(result.settings.maxLotSize).toBe(0.03);
    expect(result.settings.maxOpenTrades).toBe(1);
    expect(result.settings.maxTradesPerDay).toBe(3);
  });

  it("never loosens stricter user settings", () => {
    const strict = { ...settings, maxRiskPerTradePct: 0.1, maxLotSize: 0.02, maxOpenTrades: 1 };
    const result = adaptiveRiskSettings(strict, 20_000, true);
    expect(result.settings.maxRiskPerTradePct).toBe(0.1);
    expect(result.settings.maxLotSize).toBe(0.02);
    expect(result.settings.maxOpenTrades).toBe(1);
  });

  it("lets AI reduce lots but not increase the equity-sized amount", () => {
    const reduced = applyAiLotSizing({
      baseLots: 0.1, direction: "buy", enabled: true, pureLogic: false, instrument,
      decision: { decision: "buy", confidence: 0.9, reasoning: "ok", risk_level: "medium", news_risk: "low", should_execute: true },
      judgment: {
        action: "BUY", confidence: 90, position_size_percent: 50, stop_loss: null, take_profit: null,
        risk_reward_ratio: null, risk_level: "MEDIUM", reasons_for_trade: [], reasons_against_trade: [],
        trade_invalidators: [], required_confirmations: [], market_regime: "", expected_holding_time: "",
        missing_data: [], final_verdict: "trade",
      },
    });
    expect(reduced.lots).toBe(0.05);
    expect(reduced.lots).toBeLessThanOrEqual(reduced.baseLots);
  });
});
