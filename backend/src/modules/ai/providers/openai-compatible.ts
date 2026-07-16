import { CircuitOpenError, circuitSnapshot, withResilience } from "../../../lib/resilience.js";
import { reportIncident, resolveIncidentByDedupeKey } from "../../incidents/service.js";
import { resolveProviderConfig } from "../provider-config.js";
import { getOperationalConfig } from "../../system/operational-config.js";
import type { GenerateRequest, ProviderStatus } from "./types.js";

type OpenAiCompatibleProvider = "openai" | "openrouter" | "nvidia";
const LABELS: Record<OpenAiCompatibleProvider, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  nvidia: "NVIDIA NIM",
};
const extraHeadersFor = (provider: OpenAiCompatibleProvider): Record<string, string> =>
  provider === "openrouter" ? { "X-Title": "MT5 AI Trading Bot" } : {};

/**
 * One client for every OpenAI-compatible chat-completions API — OpenAI,
 * OpenRouter, and any drop-in endpoint (Together, Groq, DeepSeek, local vLLM…)
 * via a configurable base URL. A single active provider is used; there is no
 * co-working/fallback here.
 */

/** Pure: build the chat-completions request body (testable, no I/O). */
export function buildChatCompletionsBody(model: string, request: GenerateRequest): Record<string, unknown> {
  return {
    model,
    temperature: request.temperature,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
    ...(request.json ? { response_format: { type: "json_object" } } : {}),
  };
}

/** Pure: pull the assistant text out of a chat-completions response. */
export function extractChatContent(payload: unknown): string {
  const choices = (payload as { choices?: { message?: { content?: string } }[] }).choices ?? [];
  return choices[0]?.message?.content ?? "";
}

async function generate(provider: OpenAiCompatibleProvider, request: GenerateRequest): Promise<string> {
  const cfg = await resolveProviderConfig(provider);
  const model = request.model?.trim() || cfg.model;
  const { aiRequestTimeoutMs } = await getOperationalConfig();
  const label = LABELS[provider];
  if (!cfg.apiKey || !model) throw new Error(`${label} is not configured`);
  try {
    const response = await withResilience("ai", async () => {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
          ...extraHeadersFor(provider),
        },
        body: JSON.stringify(buildChatCompletionsBody(model, request)),
        signal: AbortSignal.timeout(aiRequestTimeoutMs),
      });
      if (!res.ok) throw new Error(`${label} returned ${res.status}`);
      return extractChatContent(await res.json());
    }, { retries: 2, baseDelayMs: 300, maxDelayMs: 1200, failureThreshold: 3, cooldownMs: 30_000 });
    await resolveIncidentByDedupeKey("ai:circuit-open", "system").catch(() => undefined);
    return response;
  } catch (error) {
    const state = circuitSnapshot("ai");
    if (error instanceof CircuitOpenError || (!Array.isArray(state) && state?.status === "open")) {
      await reportIncident({
        dedupeKey: "ai:circuit-open",
        severity: "CRITICAL",
        source: "ai",
        title: `${label} circuit open`,
        message: "AI requests are blocked after repeated failures; trade vetting remains fail-closed.",
        context: { provider, error: String(error) },
        minIntervalMs: 60_000,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function status(provider: OpenAiCompatibleProvider): Promise<ProviderStatus> {
  const cfg = await resolveProviderConfig(provider);
  if (!cfg.apiKey || !cfg.model) return { reachable: false, modelPresent: false };
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}`, ...extraHeadersFor(provider) },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { reachable: false, modelPresent: false };
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((model) => model.id ?? "");
    // Some gateways list hundreds of models; treat reachable+empty list as present.
    return { reachable: true, modelPresent: ids.length === 0 || ids.includes(cfg.model) };
  } catch {
    return { reachable: false, modelPresent: false };
  }
}

export const openaiGenerate = (request: GenerateRequest) => generate("openai", request);
export const openaiStatus = () => status("openai");
export const openrouterGenerate = (request: GenerateRequest) => generate("openrouter", request);
export const openrouterStatus = () => status("openrouter");
export const nvidiaGenerate = (request: GenerateRequest) => generate("nvidia", request);
export const nvidiaStatus = () => status("nvidia");
