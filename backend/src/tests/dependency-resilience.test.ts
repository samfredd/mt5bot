import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/audit.js", () => ({
  audit: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
}));

vi.mock("../lib/redis.js", () => ({
  readJson: vi.fn(async () => null),
  writeJson: vi.fn(async () => true),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    systemSetting: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
      where.key === "ai_provider" ? { value: { provider: "ollama" } } : null), upsert: vi.fn(async () => ({})) },
  },
}));

const { __resetCircuitsForTests } = await import("../lib/resilience.js");
const { mt5 } = await import("../modules/mt5/client.js");
const { generateJson } = await import("../modules/ai/service.js");

describe("dependency resilience integration", () => {
  beforeEach(() => {
    __resetCircuitsForTests();
    vi.restoreAllMocks();
  });

  it("retries idempotent MT5 reads", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary bridge failure");
      return new Response(JSON.stringify({ ok: true, mock: false, connected: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await expect(mt5.health()).resolves.toMatchObject({ ok: true, connected: true });
    expect(attempts).toBe(2);
  });

  it("does not retry uncertain order placement", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/symbols")) {
        return new Response(JSON.stringify({ symbols: ["EURUSD"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/order")) throw new Error("connection dropped after send");
      throw new Error(`unexpected URL ${url}`);
    }));

    await expect(mt5.placeOrder({ symbol: "EURUSD", direction: "buy", volume: 0.1 }, "test"))
      .rejects.toThrow("connection dropped after send");
    expect(calls.filter((url) => url.endsWith("/order"))).toHaveLength(1);
  });

  it("retries idempotent AI generation", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary model failure");
      return new Response(JSON.stringify({ response: "{\"sentiment\":\"neutral\"}" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await expect(generateJson("classify")).resolves.toEqual({ sentiment: "neutral" });
    expect(attempts).toBe(2);
  });
});
