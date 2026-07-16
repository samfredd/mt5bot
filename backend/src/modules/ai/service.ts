import { prisma } from "../../lib/prisma.js";
import { logError } from "../../lib/audit.js";
import {
  AI_SAFE_FALLBACK,
  AiDecisionSchema,
  TradeJudgmentSchema,
  judgmentToDecision,
  type AiDecision,
  type TradeJudgment,
} from "./schema.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { anthropicGenerate, anthropicStatus } from "./providers/anthropic.js";
import { ollamaGenerate, ollamaStatus } from "./providers/ollama.js";
import { nvidiaGenerate, nvidiaStatus, openaiGenerate, openaiStatus, openrouterGenerate, openrouterStatus } from "./providers/openai-compatible.js";
import { PROVIDER_NAMES, PURE_LOGIC_PROVIDER, isAiMode, isProviderName, type AiMode, type GenerateRequest, type ProviderName, type ProviderStatus } from "./providers/types.js";
import { providerConfigSummaries, resolveProviderConfig } from "./provider-config.js";
import { getOperationalConfig } from "../system/operational-config.js";
import { relevantMemory, type MemoryQuery } from "../memory/service.js";

export { PROVIDER_NAMES, PURE_LOGIC_PROVIDER, isAiMode, isProviderName } from "./providers/types.js";
export type { AiMode, ProviderName } from "./providers/types.js";

interface Provider {
  generate: (request: GenerateRequest) => Promise<string>;
  status: () => Promise<ProviderStatus>;
}

const PROVIDERS: Record<ProviderName, Provider> = {
  ollama: { generate: ollamaGenerate, status: ollamaStatus },
  anthropic: { generate: anthropicGenerate, status: anthropicStatus },
  openai: { generate: openaiGenerate, status: openaiStatus },
  openrouter: { generate: openrouterGenerate, status: openrouterStatus },
  nvidia: { generate: nvidiaGenerate, status: nvidiaStatus },
};

/**
 * The one active AI mode. It defaults to pure logic so the bot is useful and
 * safe even before any model is configured. A real provider can be switched at
 * runtime (persisted in SystemSetting) so you can move fully between Ollama,
 * OpenAI, OpenRouter, NVIDIA NIM, Claude, etc. without a restart. Exactly one provider is
 * ever used — no co-working/fallback (research fallback is an explicit opt-in).
 */
let activeCache: { provider: AiMode; ts: number } | null = null;
const ACTIVE_TTL_MS = 5_000;

export async function getActiveProvider(): Promise<AiMode> {
  if (activeCache && Date.now() - activeCache.ts < ACTIVE_TTL_MS) return activeCache.provider;
  let provider: AiMode = PURE_LOGIC_PROVIDER;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: "ai_provider" } });
    const stored = (row?.value as { provider?: string } | undefined)?.provider;
    if (stored && isAiMode(stored)) provider = stored;
  } catch {
    /* fall back to the safe default */
  }
  activeCache = { provider, ts: Date.now() };
  return provider;
}

export async function setActiveProvider(provider: AiMode): Promise<void> {
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

export interface AskModelResult {
  decision: AiDecision;
  /** Full decision-framework output when the model answered in trade-judge form. */
  judgment: TradeJudgment | null;
  logId: string;
  valid: boolean;
}

/**
 * Compatibility decision for pipelines that normally receive an AI verdict.
 * It is deliberately marked in the caller's audit/explanation as pure logic;
 * it only means the deterministic signal is allowed through to the risk gate.
 */
export function pureLogicDecision(direction: "buy" | "sell"): AiDecision {
  return {
    decision: direction,
    confidence: 1,
    reasoning: "Pure logic mode: no AI model was called; technical signal and risk controls decide.",
    risk_level: "low",
    suggested_entry: null,
    suggested_stop_loss: null,
    suggested_take_profit: null,
    news_risk: "low",
    should_execute: true,
  };
}

export async function askModel(prompt: string, symbol: string, memory?: Omit<MemoryQuery, "symbol">): Promise<AskModelResult> {
  return askModelWithSystem(SYSTEM_PROMPT, prompt, symbol, memory);
}

/**
 * Same contract as {@link askModel} but with a caller-supplied system prompt, so
 * specialized modes (e.g. scalping fire-control) can steer the model while still
 * reusing the one provider abstraction, JSON validation, and AiAnalysisLog
 * logging. The AI stays advisory — `valid`/`decision` are re-checked downstream.
 *
 * Responses are parsed judgment-first (the trade-judge decision framework),
 * falling back to the legacy AiDecision shape for prompts that still ask for
 * it (copy vetting, daily summary, scalping fire control). Either shape counts
 * as valid; anything else falls back to "avoid".
 */
export async function askModelWithSystem(
  system: string,
  prompt: string,
  symbol: string,
  memory?: Omit<MemoryQuery, "symbol">,
): Promise<AskModelResult> {
  const provider = await getActiveProvider();
  if (provider === PURE_LOGIC_PROVIDER) {
    const log = await prisma.aiAnalysisLog.create({
      data: {
        symbol,
        model: PURE_LOGIC_PROVIDER,
        prompt,
        response: { skipped: true, reason: "Pure logic mode is selected; no model was called." },
        decision: "avoid",
        confidence: 0,
        valid: false,
      },
    });
    return { decision: AI_SAFE_FALLBACK, judgment: null, logId: log.id, valid: false };
  }
  const memoryText = memory ? await relevantMemory({ ...memory, symbol }).catch(() => "") : "";
  const groundedPrompt = memoryText ? `${prompt}\n\n${memoryText}` : prompt;
  let raw = "";
  let decision: AiDecision = AI_SAFE_FALLBACK;
  let judgment: TradeJudgment | null = null;
  let valid = false;
  try {
    raw = await PROVIDERS[provider].generate({ system, prompt: groundedPrompt, json: true, temperature: 0.2 });
    const json = extractJson(raw);
    const parsedJudgment = TradeJudgmentSchema.safeParse(json);
    if (parsedJudgment.success) {
      judgment = parsedJudgment.data;
      decision = judgmentToDecision(judgment);
      valid = true;
    } else {
      const parsedLegacy = AiDecisionSchema.safeParse(json);
      if (parsedLegacy.success) {
        decision = parsedLegacy.data;
        valid = true;
      } else {
        await logError("ai", "AI response failed validation", {
          symbol,
          provider,
          judgmentIssues: parsedJudgment.error.issues.slice(0, 5),
          legacyIssues: parsedLegacy.error.issues.slice(0, 5),
        });
      }
    }
  } catch (error) {
    await logError("ai", "trade-vetting provider call failed", { symbol, provider, error: String(error) });
  }
  const model = (await resolveProviderConfig(provider)).model;
  const log = await prisma.aiAnalysisLog.create({
    data: {
      symbol,
      model: `${provider}:${model}`,
      prompt: groundedPrompt,
      response: { raw, parsed: decision, judgment, provider } as object,
      decision: decision.decision,
      confidence: decision.confidence,
      valid,
    },
  });
  return { decision, judgment, logId: log.id, valid };
}

export async function generateJson(
  prompt: string,
  system?: string,
  options: { provider?: ProviderName; model?: string } = {},
): Promise<unknown> {
  const request: GenerateRequest = {
    system: system ?? "You are a precise classifier. Respond with ONLY a single JSON object, no commentary.",
    prompt,
    json: true,
    temperature: 0.1,
    model: options.model,
  };
  const active: AiMode = options.provider ?? await getActiveProvider();
  if (active === PURE_LOGIC_PROVIDER) return null;
  // Single provider by default. Research fallback to Ollama only if explicitly
  // enabled (AI_RESEARCH_FALLBACK_TO_OLLAMA) — off by default.
  const providers: ProviderName[] = (await getOperationalConfig()).aiResearchFallbackToOllama && active !== "ollama"
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

/** Plain-text generation for the operator assistant, optionally using its own provider/model. */
export async function generateAssistantText(input: {
  prompt: string;
  system: string;
  provider?: ProviderName;
  model?: string;
}): Promise<{ text: string; provider: AiMode; model: string }> {
  const provider: AiMode = input.provider ?? await getActiveProvider();
  if (provider === PURE_LOGIC_PROVIDER) return { text: "", provider, model: "" };
  const configured = await resolveProviderConfig(provider);
  const model = input.model?.trim() || configured.model;
  const text = await PROVIDERS[provider].generate({
    system: input.system,
    prompt: input.prompt,
    json: false,
    temperature: 0.2,
    model,
  });
  await prisma.aiAnalysisLog.create({
    data: {
      symbol: "SYSTEM_ASSISTANT",
      model: `${provider}:${model}`,
      prompt: input.prompt.slice(0, 20_000),
      response: { raw: text, provider },
      decision: "assistant_response",
      valid: Boolean(text.trim()),
    },
  });
  return { text, provider, model };
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
  provider: AiMode;
  recentValidRate: number | null;
  recentSamples: number;
  lastValidAt: string | null;
}

export async function aiHealth(): Promise<AiHealth> {
  const provider = await getActiveProvider();
  if (provider === PURE_LOGIC_PROVIDER) {
    return {
      reachable: true,
      modelPresent: false,
      model: "",
      provider,
      recentValidRate: null,
      recentSamples: 0,
      lastValidAt: null,
    };
  }
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
