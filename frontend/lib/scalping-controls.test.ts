import { describe, expect, it } from "vitest";
import { scalpingControlState } from "./scalping-controls";

describe("scalpingControlState", () => {
  it("matches main bot start/pause semantics while running", () => {
    expect(scalpingControlState("running", false)).toEqual({
      running: true,
      startDisabled: true,
      pauseDisabled: false,
      stopDisabled: false,
      startLabel: "Running",
      pauseLabel: "Pause",
    });
  });

  it("blocks start while emergency stop is active", () => {
    expect(scalpingControlState("stopped", true).startDisabled).toBe(true);
  });
});
