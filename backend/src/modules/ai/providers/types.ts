export interface GenerateRequest {
  system: string;
  prompt: string;
  json: boolean;
  temperature: number;
  /** Optional per-call model override (used by the operator assistant). */
  model?: string;
}

export interface ProviderStatus {
  reachable: boolean;
  modelPresent: boolean;
}

export type ProviderName = "ollama" | "anthropic" | "openai" | "openrouter" | "nvidia";
export const PROVIDER_NAMES: ProviderName[] = ["ollama", "anthropic", "openai", "openrouter", "nvidia"];
export const isProviderName = (value: string): value is ProviderName => (PROVIDER_NAMES as string[]).includes(value);

/** A real model provider, or the explicit deterministic no-model operating mode. */
export const PURE_LOGIC_PROVIDER = "pure_logic" as const;
export type AiMode = ProviderName | typeof PURE_LOGIC_PROVIDER;
export const isAiMode = (value: string): value is AiMode => value === PURE_LOGIC_PROVIDER || isProviderName(value);
