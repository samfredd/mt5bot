import { describe, expect, it, vi } from "vitest";
import { runCoordinatedAnalysisCycle } from "../workers/scheduler-cycle.js";

describe("scheduler cycle coordination", () => {
  it("runs protective work even when the new-trade lease is unavailable", async () => {
    const protect = vi.fn(async () => {});
    const newTradeWork = vi.fn(async () => {});
    const withLease = vi.fn(async () => null);

    await runCoordinatedAnalysisCycle({ protect, newTradeWork, withLease });

    expect(protect).toHaveBeenCalledOnce();
    expect(withLease).toHaveBeenCalledOnce();
    expect(newTradeWork).not.toHaveBeenCalled();
  });

  it("runs new-trade work only inside the acquired lease", async () => {
    const order: string[] = [];
    await runCoordinatedAnalysisCycle({
      protect: async () => { order.push("protect"); },
      newTradeWork: async () => { order.push("new-trades"); },
      withLease: async (work) => { order.push("lease"); await work(); return true; },
    });
    expect(order).toEqual(["protect", "lease", "new-trades"]);
  });
});
