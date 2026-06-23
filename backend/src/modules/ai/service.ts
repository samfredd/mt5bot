import { config } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { logError } from "../../lib/audit.js";
import { AI_SAFE_FALLBACK, AiDecisionSchema, type AiDecision } from "./schema.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { anthropicGenerate, anthropicStatus } from "./providers/anthropic.js";
import { ollamaGenerate, ollamaStatus } from "./providers/ollama.js";
import { openaiGenerate, openaiStatus, openrouterGenerate, openrouterStatus } from "./providers/openai-compatible.js";
import { PROVIDER_NAMES, isProviderName, type GenerateRequest, type ProviderName, type ProviderStatus } from "./providers/types.js";
import { providerConfigSummaries, resolveProviderConfig } from "./provider-config.js";

export { PROVIDER_NAMES, isProviderName } from "./providers/types.js";
export type { ProviderName } from "./providers/types.js";

interface Provider {
  generate: (request: GenerateRequest) => Promise<string>;
  status: () => Promise<ProviderStatus>;
}

const PROVIDERS: Record<ProviderName, Provider> = {
  ollama: { generate: ollamaGenerate, status: ollamaStatus },
  anthropic: { generate: anthropicGenerate, status: anthropicStatus },
  openai: { generate: openaiGenerate, status: openaiStatus },
  openrouter: { generate: openrouterGenerate, status: openrouterStatus },
};

/**
 * The ONE active provider. Defaults to AI_PROVIDER but can be switched at
 * runtime (persisted in SystemSetting) so you can move fully between Ollama,
 * OpenAI, OpenRouter, Claude, etc. without a restart. Exactly one provider is
 * ever used — no co-working/fallback (research fallback is an explicit opt-in).
 */
let activeCache: { provider: ProviderName; ts: number } | null = null;
const ACTIVE_TTL_MS = 5_000;

export async function getActiveProvider(): Promise<ProviderName> {
  if (activeCache && Date.now() - activeCache.ts < ACTIVE_TTL_MS) return activeCache.provider;
  let provider = config.AI_PROVIDER as ProviderName;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: "ai_provider" } });
    const stored = (row?.value as { provider?: string } | undefined)?.provider;
    if (stored && isProviderName(stored)) provider = stored;
  } catch {
    /* fall back to the configured default */
  }
  activeCache = { provider, ts: Date.now() };
  return provider;
}

export async function setActiveProvider(provider: ProviderName): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: "ai_provider" },
    create: { key: "ai_provider", value: { provider } },
    update: { value: { provider } },
  });
  activeCache = { provider, ts: Date.now() };
}

/** Per-provider config + status for the Settings UI (never includes secrets). */
export async function availableProviders() {
  return providerConfigSummaries();
}

export async function askModel(prompt: string, symbol: string): Promise<{ decision: AiDecision; logId: string; valid: boolean }> {
  return askModelWithSystem(SYSTEM_PROMPT, prompt, symbol);
}

/**
 * Same contract as {@link askModel} but with a caller-supplied system prompt, so
 * specialized modes (e.g. scalping fire-control) can steer the model while still
 * reusing the one provider abstraction, JSON validation, and AiAnalysisLog
 * logging. The AI stays advisory — `valid`/`decision` are re-checked downstream.
 */
export async function askModelWithSystem(
  system: string,
  prompt: string,
  symbol: string,
): Promise<{ decision: AiDecision; logId: string; valid: boolean }> {
  const provider = await getActiveProvider();
  let raw = "";
  let decision: AiDecision = AI_SAFE_FALLBACK;
  let valid = false;
  try {
    raw = await PROVIDERS[provider].generate({ system, prompt, json: true, temperature: 0.2 });
    const parsed = AiDecisionSchema.safeParse(extractJson(raw));
    if (parsed.success) {
      decision = parsed.data;
      valid = true;
    } else {
      await logError("ai", "AI response failed validation", { symbol, provider, issues: parsed.error.issues });
    }
  } catch (error) {
    await logError("ai", "trade-vetting provider call failed", { symbol, provider, error: String(error) });
  }
  const model = (await resolveProviderConfig(provider)).model;
  const log = await prisma.aiAnalysisLog.create({
    data: {
      symbol,
      model: `${provider}:${model}`,
      prompt,
      response: { raw, parsed: decision, provider } as object,
      decision: decision.decision,
      confidence: decision.confidence,
      valid,
    },
  });
  return { decision, logId: log.id, valid };
}

export async function generateJson(prompt: string, system?: string): Promise<unknown> {
  const request: GenerateRequest = {
    system: system ?? "You are a precise classifier. Respond with ONLY a single JSON object, no commentary.",
    prompt,
    json: true,
    temperature: 0.1,
  };
  const active = await getActiveProvider();
  // Single provider by default. Research fallback to Ollama only if explicitly
  // enabled (AI_RESEARCH_FALLBACK_TO_OLLAMA) — off by default.
  const providers: ProviderName[] = config.AI_RESEARCH_FALLBACK_TO_OLLAMA && active !== "ollama"
    ? [active, "ollama"]
    : [active];
  for (const provider of providers) {
    try {
      const parsed = extractJson(await PROVIDERS[provider].generate(request));
      if (parsed !== null) return parsed;
      await logError("ai", "generateJson returned invalid JSON", { provider });
    } catch (error) {
      await logError("ai", "generateJson provider failed", { provider, error: String(error) });
    }
  }
  return null;
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export async function ollamaHealthy(): Promise<boolean> {
  return (await ollamaStatus()).reachable;
}

export interface AiHealth {
  reachable: boolean;
  modelPresent: boolean;
  model: string;
  provider: ProviderName;
  recentValidRate: number | null;
  recentSamples: number;
  lastValidAt: string | null;
}

export async function aiHealth(): Promise<AiHealth> {
  const provider = await getActiveProvider();
  const [status, resolved] = await Promise.all([PROVIDERS[provider].status(), resolveProviderConfig(provider)]);
  const recent = await prisma.aiAnalysisLog.findMany({
    orderBy: { createdAt: "desc" }, take: 20, select: { valid: true, createdAt: true },
  });
  const valids = recent.filter((row) => row.valid);
  return {
    ...status,
    model: resolved.model,
    provider,
    recentValidRate: recent.length ? Number((valids.length / recent.length).toFixed(2)) : null,
    recentSamples: recent.length,
    lastValidAt: valids[0]?.createdAt.toISOString() ?? null,
  };
}
