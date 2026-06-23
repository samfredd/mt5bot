import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envKeys = ["LIVE_TRADING_ENABLED", "DEMO_MODE"] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

const h = vi.hoisted(() => ({
  redisAvailable: true,
  redisValues: new Map<string, unknown>(),
  systemValues: new Map<string, unknown>(),
  leaseHeld: false,
  released: [] as { key: string; owner: string }[],
}));

vi.mock("../lib/redis.js", () => ({
  readJson: vi.fn(async (key: string) => h.redisValues.get(key) ?? null),
  writeJson: vi.fn(async (key: string, value: unknown) => {
    if (!h.redisAvailable) return false;
    h.redisValues.set(key, value);
    return true;
  }),
  redisAvailable: vi.fn(async () => h.redisAvailable),
  acquireLease: vi.fn(async () => {
    if (h.leaseHeld) return false;
    h.leaseHeld = true;
    return true;
  }),
  renewLease: vi.fn(async () => true),
  releaseLease: vi.fn(async (key: string, owner: string) => {
    h.released.push({ key, owner });
    h.leaseHeld = false;
    return true;
  }),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const value = h.systemValues.get(where.key);
        return value === undefined ? null : { key: where.key, value };
      }),
      upsert: vi.fn(async ({ where, create, update }: {
        where: { key: string };
        create: { value: unknown };
        update: { value: unknown };
      }) => {
        const value = h.systemValues.has(where.key) ? update.value : create.value;
        h.systemValues.set(where.key, value);
        return { key: where.key, value };
      }),
    },
    user: { count: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock("../lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));

describe("operational state", () => {
  beforeEach(() => {
    h.redisAvailable = true;
    h.redisValues = new Map();
    h.systemValues = new Map();
    h.leaseHeld = false;
    h.released = [];
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("loads bot state from Redis before Postgres", async () => {
    h.redisValues.set("bot:state", {
      status: "paused",
      mode: "SEMI_AUTO",
      emergencyStop: false,
      demoMode: true,
      liveTradingEnabled: false,
    });
    const { getBotState } = await import("../modules/system/state.js");
    await expect(getBotState()).resolves.toMatchObject({ status: "paused", mode: "SEMI_AUTO" });
  });

  it("persists state durably and mirrors it to Redis", async () => {
    const { setBotState } = await import("../modules/system/state.js");
    await setBotState({ status: "running" }, "tester");
    expect(h.systemValues.get("bot_state")).toMatchObject({ status: "running" });
    expect(h.redisValues.get("bot:state")).toMatchObject({ status: "running" });
  });

  it("lets Settings-backed state enable live trading without an env kill switch", async () => {
    process.env.LIVE_TRADING_ENABLED = "false";
    process.env.DEMO_MODE = "true";
    vi.resetModules();

    const { setBotState } = await import("../modules/system/state.js");
    const next = await setBotState({ liveTradingEnabled: true, demoMode: false }, "tester");

    expect(next).toMatchObject({ liveTradingEnabled: true, demoMode: false });
    expect(h.systemValues.get("bot_state")).toMatchObject({ liveTradingEnabled: true, demoMode: false });
  });

  it("fails new trading closed when Redis is unavailable", async () => {
    h.redisAvailable = false;
    const { operationalTradingAvailable } = await import("../modules/system/state.js");
    await expect(operationalTradingAvailable()).resolves.toBe(false);
  });

  it("mirrors token revocation cutoffs in Redis", async () => {
    const { revokeUserTokens, tokensValidAfter } = await import("../modules/auth/service.js");
    await revokeUserTokens("u1");
    expect(h.redisValues.has("jwt:revoked:u1")).toBe(true);
    await expect(tokensValidAfter("u1")).resolves.toBeTypeOf("number");
  });

  it("skips overlapping scheduler work and releases owned leases", async () => {
    const { withSchedulerLease } = await import("../workers/scheduler-lease.js");
    h.leaseHeld = true;
    expect(await withSchedulerLease("analysis", 30_000, async () => "ran")).toBeNull();

    h.leaseHeld = false;
    expect(await withSchedulerLease("analysis", 30_000, async () => "ran")).toBe("ran");
    expect(h.released).toHaveLength(1);
  });
});
