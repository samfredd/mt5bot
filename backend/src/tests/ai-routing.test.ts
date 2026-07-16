import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  provider: "anthropic" as "anthropic" | "ollama",
  fallback: true,
  anthropic: vi.fn(),
  ollama: vi.fn(),
  logs: [] as Record<string, unknown>[],
}));

vi.mock("../config.js", () => ({
  config: {
    AI_PROVIDER: h.provider,
    AI_RESEARCH_FALLBACK_TO_OLLAMA: h.fallback,
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_MODEL: "configured-claude-model",
    OLLAMA_URL: "http://ollama",
    OLLAMA_MODEL: "local-model",
    OLLAMA_TIMEOUT_MS: 1000,
  },
}));
vi.mock("../modules/system/operational-config.js", () => ({
  getOperationalConfig: vi.fn(async () => ({ aiResearchFallbackToOllama: h.fallback })),
}));

vi.mock("../modules/ai/providers/anthropic.js", () => ({
  anthropicGenerate: h.anthropic,
  anthropicStatus: vi.fn(async () => ({ reachable: true, modelPresent: true })),
}));
vi.mock("../modules/ai/providers/ollama.js", () => ({ ollamaGenerate: h.ollama, ollamaStatus: vi.fn(async () => ({ reachable: true, modelPresent: true })) }));
vi.mock("../modules/ai/providers/openai-compatible.js", () => ({
  openaiGenerate: vi.fn(), openaiStatus: vi.fn(async () => ({ reachable: false, modelPresent: false })),
  openrouterGenerate: vi.fn(), openrouterStatus: vi.fn(async () => ({ reachable: false, modelPresent: false })),
  nvidiaGenerate: vi.fn(), nvidiaStatus: vi.fn(async () => ({ reachable: false, modelPresent: false })),
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    aiAnalysisLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.logs.push(data);
        return { id: `a${h.logs.length}`, ...data };
      }),
      findMany: vi.fn(async () => []),
    },
    systemSetting: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) => where.key === "ai_provider" ? { value: { provider: h.provider } } : null), upsert: vi.fn(async () => ({})) },
  },
}));
vi.mock("../lib/audit.js", () => ({ logError: vi.fn(async () => {}) }));

const { askModel, generateJson } = await import("../modules/ai/service.js");

beforeEach(() => {
  h.provider = "anthropic";
  h.fallback = true;
  h.anthropic.mockReset();
  h.ollama.mockReset();
  h.logs = [];
});

describe("AI provider routing", () => {
  it("uses configured Claude for trade vetting", async () => {
    h.anthropic.mockResolvedValue(JSON.stringify({
      decision: "buy",
      confidence: 0.9,
      reasoning: "valid",
      risk_level: "low",
      suggested_stop_loss: null,
      suggested_take_profit: null,
      news_risk: "low",
      should_execute: true,
    }));

    const result = await askModel("prompt", "EURUSD");

    expect(result.valid).toBe(true);
    expect(h.anthropic).toHaveBeenCalledOnce();
    expect(h.ollama).not.toHaveBeenCalled();
  });

  it("falls back to Ollama only for non-order-critical JSON generation", async () => {
    h.anthropic.mockRejectedValue(new Error("Claude unavailable"));
    h.ollama.mockResolvedValue('{"sentiment":"neutral"}');

    await expect(generateJson("classify")).resolves.toEqual({ sentiment: "neutral" });
    expect(h.anthropic).toHaveBeenCalledOnce();
    expect(h.ollama).toHaveBeenCalledOnce();
  });

  it("fails trade vetting closed without falling back", async () => {
    h.anthropic.mockRejectedValue(new Error("Claude unavailable"));
    h.ollama.mockResolvedValue("{}");

    const result = await askModel("prompt", "EURUSD");

    expect(result.valid).toBe(false);
    expect(result.decision.decision).toBe("avoid");
    expect(h.ollama).not.toHaveBeenCalled();
  });
});
