import { resolveProviderConfig } from "./provider-config.js";
import type { ProviderName } from "./providers/types.js";

type OpenAiModelsPayload = { data?: Array<{ id?: string }> };
type OllamaModelsPayload = { models?: Array<{ name?: string; model?: string }> };

/** Normalize the different provider catalog response shapes without exposing credentials. */
export function parseProviderModels(provider: ProviderName, payload: unknown): string[] {
  const values = provider === "ollama"
    ? ((payload as OllamaModelsPayload).models ?? []).map((item) => item.name ?? item.model ?? "")
    : ((payload as OpenAiModelsPayload).data ?? []).map((item) => item.id ?? "");
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 1000);
}

export async function fetchProviderModels(provider: ProviderName): Promise<string[]> {
  const config = await resolveProviderConfig(provider);
  if (provider !== "ollama" && !config.apiKey) {
    throw new Error(`save the ${provider} API key before loading models`);
  }

  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = provider === "ollama"
    ? `${baseUrl}/api/tags`
    : provider === "anthropic"
      ? "https://api.anthropic.com/v1/models?limit=100"
      : `${baseUrl}/models`;
  const headers: Record<string, string> = provider === "anthropic"
    ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }
    : provider === "ollama"
      ? {}
      : { authorization: `Bearer ${config.apiKey}` };

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${provider} model catalog returned ${response.status}`);
  return parseProviderModels(provider, await response.json());
}
