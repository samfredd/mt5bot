import { afterEach, describe, expect, it, vi } from "vitest";

const keys = ["JWT_SECRET", "CREDENTIALS_ENC_KEY", "DATABASE_URL"] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("bootstrap configuration defaults", () => {
  it("does not require a dotenv file in development", async () => {
    process.env.JWT_SECRET = "test-secret-test-secret";
    process.env.CREDENTIALS_ENC_KEY = "0".repeat(64);
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    vi.resetModules();

    const { config } = await import("../config.js");

    expect(config.DATABASE_URL).toBe("postgresql://test:test@localhost:5432/test");
  });
});
