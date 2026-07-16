import { prisma } from "../../lib/prisma.js";
import { encryptSecret, decryptSecret } from "../../lib/crypto.js";
import { PROVIDER_NAMES, type ProviderName } from "./providers/types.js";

/**
 * Provider configuration (API keys, models, base URLs) editable from the
 * Settings UI and persisted in the DB — so you can add/change a provider
 * without touching .env or restarting.
 * API keys are encrypted at rest (AES-256-GCM) and never returned to clients.
 */

export interface ResolvedProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

interface StoredEntry {
  model?: string;
  baseUrl?: string;
  apiKeyEnc?: string;
}
type StoredConfig = Partial<Record<ProviderName, StoredEntry>>;

const KEY = "ai_provider_config";
const TTL_MS = 5_000;
let cache: { value: StoredConfig; ts: number } | null = null;

async function loadStored(): Promise<StoredConfig> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.value;
  let value: StoredConfig = {};
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
    value = (row?.value as StoredConfig | undefined) ?? {};
  } catch {
    /* database not ready yet: use safe built-in defaults */
  }
  cache = { value, ts: Date.now() };
  return value;
}

function providerDefaults(provider: ProviderName): ResolvedProviderConfig {
  switch (provider) {
    case "ollama": return { apiKey: "", model: "gemma3:12b", baseUrl: "http://localhost:11434" };
    case "anthropic": return { apiKey: "", model: "", baseUrl: "" };
    case "openai": return { apiKey: "", model: "", baseUrl: "https://api.openai.com/v1" };
    case "openrouter": return { apiKey: "", model: "", baseUrl: "https://openrouter.ai/api/v1" };
    case "nvidia": return {
      apiKey: "",
      model: "nvidia/nemotron-3-super-120b-a12b",
      baseUrl: "https://integrate.api.nvidia.com/v1",
    };
  }
}

/** Effective config for a provider — stored values over safe built-in defaults. */
export async function resolveProviderConfig(provider: ProviderName): Promise<ResolvedProviderConfig> {
  const env = providerDefaults(provider);
  const stored = (await loadStored())[provider];
  let apiKey = env.apiKey;
  if (stored?.apiKeyEnc) {
    try { apiKey = decryptSecret(stored.apiKeyEnc); } catch { /* treat unreadable key as unavailable */ }
  }
  return {
    apiKey,
    model: stored?.model?.trim() || env.model,
    baseUrl: stored?.baseUrl?.trim() || env.baseUrl,
  };
}

export const requiresKey = (provider: ProviderName) => provider !== "ollama";

export interface ProviderConfigSummary {
  name: ProviderName;
  model: string;
  baseUrl: string;
  requiresKey: boolean;
  hasKey: boolean;
  configured: boolean;
  keySource: "db" | "none";
}

/** Per-provider config for the UI — never includes the secret itself. */
export async function providerConfigSummaries(): Promise<ProviderConfigSummary[]> {
  const stored = await loadStored();
  return Promise.all(PROVIDER_NAMES.map(async (name) => {
    const resolved = await resolveProviderConfig(name);
    const needsKey = requiresKey(name);
    const hasKey = needsKey ? resolved.apiKey.length > 0 : true;
    const keySource: ProviderConfigSummary["keySource"] = !needsKey
      ? "none"
      : stored[name]?.apiKeyEnc ? "db" : "none";
    return {
      name,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      requiresKey: needsKey,
      hasKey,
      configured: needsKey ? hasKey && resolved.model.length > 0 : resolved.model.length > 0,
      keySource,
    };
  }));
}

export function __resetProviderConfigCacheForTests(): void {
  cache = null;
}

export async function updateProviderConfig(
  provider: ProviderName,
  patch: { apiKey?: string; model?: string; baseUrl?: string; clearKey?: boolean },
): Promise<void> {
  const stored: StoredConfig = { ...(await loadStored()) };
  const entry: StoredEntry = { ...(stored[provider] ?? {}) };
  if (patch.model !== undefined) entry.model = patch.model.trim() || undefined;
  if (patch.baseUrl !== undefined) entry.baseUrl = patch.baseUrl.trim() || undefined;
  if (patch.clearKey) delete entry.apiKeyEnc;
  else if (patch.apiKey && patch.apiKey.trim()) entry.apiKeyEnc = encryptSecret(patch.apiKey.trim());
  stored[provider] = entry;
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: stored as object },
    update: { value: stored as object },
  });
  cache = { value: stored, ts: Date.now() };
}
