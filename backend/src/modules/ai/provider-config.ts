import { config } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { encryptSecret, decryptSecret } from "../../lib/crypto.js";
import { PROVIDER_NAMES, type ProviderName } from "./providers/types.js";

/**
 * Provider configuration (API keys, models, base URLs) editable from the
 * Settings UI and persisted in the DB — so you can add/change a provider
 * without touching .env or restarting. DB values override env defaults.
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
    /* fall back to env-only */
  }
  cache = { value, ts: Date.now() };
  return value;
}

function envDefaults(provider: ProviderName): ResolvedProviderConfig {
  switch (provider) {
    case "ollama": return { apiKey: "", model: config.OLLAMA_MODEL, baseUrl: config.OLLAMA_URL };
    case "anthropic": return { apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, baseUrl: "" };
    case "openai": return { apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL, baseUrl: config.OPENAI_BASE_URL };
    case "openrouter": return { apiKey: config.OPENROUTER_API_KEY, model: config.OPENROUTER_MODEL, baseUrl: config.OPENROUTER_BASE_URL };
  }
}

/** Effective config for a provider — stored values over env defaults. */
export async function resolveProviderConfig(provider: ProviderName): Promise<ResolvedProviderConfig> {
  const env = envDefaults(provider);
  const stored = (await loadStored())[provider];
  let apiKey = env.apiKey;
  if (stored?.apiKeyEnc) {
    try { apiKey = decryptSecret(stored.apiKeyEnc); } catch { /* keep env key */ }
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
  keySource: "db" | "env" | "none";
}

/** Per-provider config for the UI — never includes the secret itself. */
export async function providerConfigSummaries(): Promise<ProviderConfigSummary[]> {
  const stored = await loadStored();
  return Promise.all(PROVIDER_NAMES.map(async (name) => {
    const resolved = await resolveProviderConfig(name);
    const needsKey = requiresKey(name);
    const hasKey = needsKey ? resolved.apiKey.length > 0 : true;
    const keySource: ProviderConfigSummary["keySource"] = !needsKey
      ? "env"
      : stored[name]?.apiKeyEnc ? "db" : resolved.apiKey ? "env" : "none";
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
