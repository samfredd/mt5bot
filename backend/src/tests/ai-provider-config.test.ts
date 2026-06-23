import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(async () => (store.value ? { key: "ai_provider_config", value: store.value } : null)),
      upsert: vi.fn(async ({ create, update }: { create: { value: unknown }; update: { value: unknown } }) => {
        store.value = store.value ? update.value : create.value;
        return {};
      }),
    },
  },
}));

const {
  resolveProviderConfig, providerConfigSummaries, updateProviderConfig, __resetProviderConfigCacheForTests,
} = await import("../modules/ai/provider-config.js");

beforeEach(() => {
  store.value = null;
  __resetProviderConfigCacheForTests();
});

describe("AI provider config (DB over env)", () => {
  it("falls back to env defaults when nothing is stored", async () => {
    const ollama = await resolveProviderConfig("ollama");
    expect(ollama.baseUrl).toBe("http://localhost:11434"); // env default
    expect(ollama.apiKey).toBe("");
  });

  it("stores a model + encrypted key and reads them back", async () => {
    await updateProviderConfig("openai", { apiKey: "sk-secret-123", model: "gpt-4o-mini" });
    __resetProviderConfigCacheForTests();
    const resolved = await resolveProviderConfig("openai");
    expect(resolved.model).toBe("gpt-4o-mini");
    expect(resolved.apiKey).toBe("sk-secret-123"); // decrypted round-trip
  });

  it("persists the key ENCRYPTED, never in plaintext", async () => {
    await updateProviderConfig("openrouter", { apiKey: "or-key-xyz", model: "anthropic/claude-3.5-sonnet" });
    expect(JSON.stringify(store.value)).not.toContain("or-key-xyz");
  });

  it("summaries report configured/hasKey but never the secret", async () => {
    await updateProviderConfig("openai", { apiKey: "sk-abc", model: "gpt-4o" });
    __resetProviderConfigCacheForTests();
    const summaries = await providerConfigSummaries();
    const openai = summaries.find((s) => s.name === "openai")!;
    expect(openai.hasKey).toBe(true);
    expect(openai.configured).toBe(true);
    expect(openai.keySource).toBe("db");
    expect(JSON.stringify(summaries)).not.toContain("sk-abc");
    // ollama needs no key
    expect(summaries.find((s) => s.name === "ollama")!.requiresKey).toBe(false);
  });

  it("clears a stored key", async () => {
    await updateProviderConfig("openai", { apiKey: "sk-temp", model: "gpt-4o" });
    await updateProviderConfig("openai", { clearKey: true });
    __resetProviderConfigCacheForTests();
    expect((await resolveProviderConfig("openai")).apiKey).toBe(""); // no env key in tests either
  });
});
