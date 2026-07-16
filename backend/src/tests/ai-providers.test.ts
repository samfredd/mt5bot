import { describe, expect, it } from "vitest";
import { buildChatCompletionsBody, extractChatContent } from "../modules/ai/providers/openai-compatible.js";
import { PROVIDER_NAMES, isProviderName } from "../modules/ai/service.js";
import { parseProviderModels } from "../modules/ai/model-catalog.js";

describe("openai-compatible request building", () => {
  it("maps system+prompt to chat messages", () => {
    const body = buildChatCompletionsBody("gpt-4o-mini", { system: "S", prompt: "P", json: false, temperature: 0.2 });
    expect(body).toMatchObject({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "system", content: "S" }, { role: "user", content: "P" }],
    });
    expect(body.response_format).toBeUndefined();
  });

  it("requests JSON mode when json is set", () => {
    const body = buildChatCompletionsBody("m", { system: "S", prompt: "P", json: true, temperature: 0 });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("extracts the assistant content", () => {
    expect(extractChatContent({ choices: [{ message: { content: "hello" } }] })).toBe("hello");
    expect(extractChatContent({})).toBe("");
    expect(extractChatContent({ choices: [] })).toBe("");
  });
});

describe("provider registry", () => {
  it("knows the five providers", () => {
    expect(PROVIDER_NAMES).toEqual(["ollama", "anthropic", "openai", "openrouter", "nvidia"]);
  });
  it("validates provider names", () => {
    expect(isProviderName("openai")).toBe(true);
    expect(isProviderName("openrouter")).toBe(true);
    expect(isProviderName("nvidia")).toBe(true);
    expect(isProviderName("gpt5")).toBe(false);
  });
});

describe("provider model catalogs", () => {
  it("normalizes OpenAI-compatible and Anthropic model lists", () => {
    expect(parseProviderModels("nvidia", { data: [{ id: "z-ai/glm-5.2" }, { id: "nvidia/nemotron" }, { id: "z-ai/glm-5.2" }] }))
      .toEqual(["nvidia/nemotron", "z-ai/glm-5.2"]);
    expect(parseProviderModels("anthropic", { data: [{ id: "claude-opus" }] })).toEqual(["claude-opus"]);
  });

  it("normalizes Ollama tag responses and removes empty entries", () => {
    expect(parseProviderModels("ollama", { models: [{ name: "gemma3:12b" }, { model: "qwen3:8b" }, {}] }))
      .toEqual(["gemma3:12b", "qwen3:8b"]);
  });
});
