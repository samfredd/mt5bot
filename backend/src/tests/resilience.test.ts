import { beforeEach, describe, expect, it } from "vitest";
import {
  CircuitOpenError,
  __resetCircuitsForTests,
  circuitSnapshot,
  withResilience,
} from "../lib/resilience.js";

describe("withResilience", () => {
  beforeEach(() => __resetCircuitsForTests());

  it("retries an idempotent operation with bounded exponential delays", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await withResilience("news", async () => {
      attempts++;
      if (attempts < 3) throw new Error("temporary");
      return "ok";
    }, {
      retries: 2,
      baseDelayMs: 10,
      maxDelayMs: 15,
      random: () => 0,
      sleep: async (ms) => { delays.push(ms); },
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 15]);
  });

  it("does not retry when retries are disabled", async () => {
    let attempts = 0;
    await expect(withResilience("orders", async () => {
      attempts++;
      throw new Error("uncertain");
    }, { retries: 0, failureThreshold: 10 })).rejects.toThrow("uncertain");
    expect(attempts).toBe(1);
  });

  it("opens after repeated failed calls and rejects during cooldown", async () => {
    let clock = 1000;
    const options = { retries: 0, failureThreshold: 2, cooldownMs: 5000, now: () => clock };

    await expect(withResilience("mt5", async () => { throw new Error("down"); }, options)).rejects.toThrow("down");
    await expect(withResilience("mt5", async () => { throw new Error("down"); }, options)).rejects.toThrow("down");
    expect(circuitSnapshot("mt5")).toMatchObject({ status: "open", failures: 2 });

    await expect(withResilience("mt5", async () => "should-not-run", options)).rejects.toBeInstanceOf(CircuitOpenError);
    clock += 1000;
    expect(circuitSnapshot("mt5")?.status).toBe("open");
  });

  it("allows a recovery probe after cooldown and closes on success", async () => {
    let clock = 1000;
    const options = { retries: 0, failureThreshold: 1, cooldownMs: 5000, now: () => clock };
    await expect(withResilience("ai", async () => { throw new Error("down"); }, options)).rejects.toThrow("down");

    clock = 7000;
    await expect(withResilience("ai", async () => "recovered", options)).resolves.toBe("recovered");
    expect(circuitSnapshot("ai")).toMatchObject({ status: "closed", failures: 0 });
  });
});
