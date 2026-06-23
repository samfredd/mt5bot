import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/redis.js", () => ({ redisAvailable: vi.fn(async () => false) }));
vi.mock("../lib/resilience.js", () => ({
  circuitSnapshot: vi.fn(() => [
    { dependency: "mt5", status: "open", failures: 3, openedAt: 1000, updatedAt: 1000 },
  ]),
}));

const { operationalHealth } = await import("../lib/operational-health.js");

describe("operationalHealth", () => {
  it("reports Redis availability and circuit snapshots", async () => {
    await expect(operationalHealth()).resolves.toEqual({
      redis: false,
      circuits: [
        { dependency: "mt5", status: "open", failures: 3, openedAt: 1000, updatedAt: 1000 },
      ],
    });
  });
});
