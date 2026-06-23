import { afterEach, describe, expect, it, vi } from "vitest";

const keys = [
  "NODE_ENV",
  "JWT_SECRET",
  "CREDENTIALS_ENC_KEY",
  "DATABASE_URL",
  "MT5_BRIDGE_API_KEY",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

function setRequired(overrides: Partial<Record<(typeof keys)[number], string>> = {}) {
  Object.assign(process.env, {
    NODE_ENV: "production",
    JWT_SECRET: "a-secure-production-jwt-secret-123",
    CREDENTIALS_ENC_KEY: "1".repeat(64),
    DATABASE_URL: "postgresql://app:strong-password@postgres:5432/mt5bot",
    MT5_BRIDGE_API_KEY: "a-secure-bridge-api-key",
    ...overrides,
  });
}

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("production configuration", () => {
  it.each([
    ["JWT_SECRET", "change-me-to-a-long-random-string"],
    ["CREDENTIALS_ENC_KEY", "0".repeat(64)],
    ["MT5_BRIDGE_API_KEY", "change-me-bridge-key"],
    ["DATABASE_URL", "postgresql://mt5bot:mt5bot@postgres:5432/mt5bot"],
  ] as const)("rejects the unsafe %s default", async (key, value) => {
    setRequired({ [key]: value });
    vi.resetModules();
    await expect(import("../config.js")).rejects.toThrow("unsafe production configuration");
  });

  it("accepts explicit safe production values", async () => {
    setRequired();
    vi.resetModules();
    const { config } = await import("../config.js");
    expect(config.NODE_ENV).toBe("production");
    expect(config.STRATEGY_VALIDATION_APPROVED).toBe(false);
  });
});
