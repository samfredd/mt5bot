import { describe, expect, it } from "vitest";
import { extractAction, normalizeAssistantSettingsAction } from "../modules/assistant/service.js";

describe("assistant deterministic system controls", () => {
  it("maps weekly-loss requests to a validated risk patch", () => {
    expect(extractAction("Set the maximum weekly loss to 6 percent")).toMatchObject({
      kind: "risk",
      patch: { maxWeeklyLossPct: 6 },
    });
  });

  it("maps scanner and day-trading controls without depending on an AI model", () => {
    expect(extractAction("enable the scanner")).toMatchObject({ kind: "settings", scope: "scanner", patch: { enabled: true } });
    expect(extractAction("turn off day trading")).toMatchObject({ kind: "settings", scope: "day_trading", patch: { enabled: false } });
  });

  it("maps boolean risk requirements", () => {
    expect(extractAction("require stop loss")).toMatchObject({ kind: "risk", patch: { requireStopLoss: true } });
    expect(extractAction("do not require take profit")).toMatchObject({ kind: "risk", patch: { requireTakeProfit: false } });
  });

  it("does not invent a value for an incomplete request", () => {
    expect(extractAction("change my risk settings")).toBeNull();
  });

  it("normalizes provider aliases and scalar strings before validation", () => {
    expect(normalizeAssistantSettingsAction({
      category: "risk settings",
      changes: { maxWeeklyLossPct: "6%", requireStopLoss: "true" },
    })).toMatchObject({ kind: "settings", scope: "risk", patch: { maxWeeklyLossPct: 6, requireStopLoss: true } });
  });

  it("rejects model-invented fields before asking the user to confirm", () => {
    expect(normalizeAssistantSettingsAction({ scope: "risk", patch: { guaranteedProfitPct: 50 }, summary: "Guarantee profit" })).toBeNull();
  });
});
