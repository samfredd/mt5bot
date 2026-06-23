import { config } from "../../../config.js";
import { withResilience } from "../../../lib/resilience.js";
import { resolveProviderConfig } from "../provider-config.js";
import type { GenerateRequest, ProviderStatus } from "./types.js";

const API_URL = "https://api.anthropic.com/v1";

function headers(apiKey: string) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

export async function anthropicGenerate(request: GenerateRequest): Promise<string> {
  const { apiKey, model } = await resolveProviderConfig("anthropic");
  if (!apiKey || !model) throw new Error("Anthropic is not configured");
  return withResilience("ai-anthropic", async () => {
    const res = await fetch(`${API_URL}/messages`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature: request.temperature,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
      }),
      signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`anthropic returned ${res.status}`);
    const payload = (await res.json()) as { content?: { type?: string; text?: string }[] };
    return (payload.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
  }, { retries: 2, baseDelayMs: 300, maxDelayMs: 1200, failureThreshold: 3, cooldownMs: 30_000 });
}

export async function anthropicStatus(): Promise<ProviderStatus> {
  const { apiKey, model } = await resolveProviderConfig("anthropic");
  if (!apiKey || !model) return { reachable: false, modelPresent: false };
  try {
    const res = await fetch(`${API_URL}/models?limit=100`, { headers: headers(apiKey), signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { reachable: false, modelPresent: false };
    const body = (await res.json()) as { data?: { id?: string }[] };
    return { reachable: true, modelPresent: (body.data ?? []).some((m) => m.id === model) };
  } catch {
    return { reachable: false, modelPresent: false };
  }
}
