import { describe, expect, it } from "vitest";
import { buildChatCompletionsBody, extractChatContent } from "../modules/ai/providers/openai-compatible.js";
import { PROVIDER_NAMES, isProviderName } from "../modules/ai/service.js";

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
  it("knows the four providers", () => {
    expect(PROVIDER_NAMES).toEqual(["ollama", "anthropic", "openai", "openrouter"]);
  });
  it("validates provider names", () => {
    expect(isProviderName("openai")).toBe(true);
    expect(isProviderName("openrouter")).toBe(true);
    expect(isProviderName("gpt5")).toBe(false);
  });
});
