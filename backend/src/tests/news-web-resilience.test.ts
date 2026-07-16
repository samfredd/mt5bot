import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ stored: 0 }));

vi.mock("../config.js", () => ({
  config: {
    NEWS_CALENDAR_URL: "https://calendar.test/events.json",
    WEB_SEARCH_PROVIDER: "tavily",
    WEB_SEARCH_API_KEY: "test-key",
  },
}));
vi.mock("../modules/system/operational-config.js", () => ({
  getOperationalConfig: vi.fn(async () => ({
    newsCalendarUrl: "https://calendar.test/events.json",
    webSearchProvider: "tavily",
    webSearchApiKey: "test-key",
  })),
}));

vi.mock("../lib/redis.js", () => ({
  readJson: vi.fn(async () => null),
  writeJson: vi.fn(async () => true),
}));

vi.mock("../lib/audit.js", () => ({
  audit: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    newsEvent: {
      upsert: vi.fn(async () => { h.stored++; return {}; }),
      findMany: vi.fn(async () => []),
    },
  },
}));

const { __resetCircuitsForTests } = await import("../lib/resilience.js");
const { refreshCalendar } = await import("../modules/news/service.js");
const { webSearch } = await import("../modules/web/search.js");

describe("news and web resilience", () => {
  beforeEach(() => {
    h.stored = 0;
    __resetCircuitsForTests();
    vi.restoreAllMocks();
  });

  it("retries the economic calendar fetch", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary calendar failure");
      return new Response(JSON.stringify([{
        title: "CPI",
        country: "USD",
        date: "2026-06-16T12:30:00.000Z",
        impact: "High",
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(refreshCalendar()).resolves.toBe(1);
    expect(attempts).toBe(2);
    expect(h.stored).toBe(1);
  });

  it("retries configured web search", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary search failure");
      return new Response(JSON.stringify({
        results: [{ title: "EUR outlook", url: "https://example.com", content: "neutral" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(webSearch("EURUSD outlook", 1)).resolves.toEqual([
      { title: "EUR outlook", url: "https://example.com", snippet: "neutral" },
    ]);
    expect(attempts).toBe(2);
  });
});
