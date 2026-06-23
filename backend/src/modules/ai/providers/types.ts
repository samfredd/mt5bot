export interface GenerateRequest {
  system: string;
  prompt: string;
  json: boolean;
  temperature: number;
}

export interface ProviderStatus {
  reachable: boolean;
  modelPresent: boolean;
}

export type ProviderName = "ollama" | "anthropic" | "openai" | "openrouter";
export const PROVIDER_NAMES: ProviderName[] = ["ollama", "anthropic", "openai", "openrouter"];
export const isProviderName = (value: string): value is ProviderName => (PROVIDER_NAMES as string[]).includes(value);
