import { config } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { logError } from "../../lib/audit.js";
import { AI_SAFE_FALLBACK, AiDecisionSchema, type AiDecision } from "./schema.js";
import { SYSTEM_PROMPT } from "./prompts.js";

/**
 * Talks to Gemma via the local Ollama API. Output is strictly validated;
 * on any failure the safe fallback ("avoid", confidence 0) is returned so a
 * broken or unavailable model can never cause a trade.
 */
export async function askModel(prompt: string, symbol: string): Promise<{ decision: AiDecision; logId: string; valid: boolean }> {
  let raw = "";
  let decision: AiDecision = AI_SAFE_FALLBACK;
  let valid = false;

  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        system: SYSTEM_PROMPT,
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama returned ${res.status}`);
    const body = (await res.json()) as { response?: string };
    raw = body.response ?? "";
    const parsed = AiDecisionSchema.safeParse(extractJson(raw));
    if (parsed.success) {
      decision = parsed.data;
      valid = true;
    } else {
      await logError("ai", "AI response failed validation", { symbol, issues: parsed.error.issues });
    }
  } catch (err) {
    await logError("ai", "Ollama call failed", { symbol, error: String(err) });
  }

  const log = await prisma.aiAnalysisLog.create({
    data: {
      symbol,
      model: config.OLLAMA_MODEL,
      prompt,
      response: { raw, parsed: decision } as object,
      decision: decision.decision,
      confidence: decision.confidence,
      valid,
    },
  });
  // `valid` lets callers distinguish a genuine "avoid" verdict from the AI
  // being unreachable/broken — they look identical in `decision` otherwise.
  return { decision, logId: log.id, valid };
}

/**
 * Generic JSON generation for non-trade tasks (headline classification,
 * summaries). Returns null on any failure — callers must treat null as
 * "no information", never as a signal.
 */
export async function generateJson(prompt: string, system?: string): Promise<unknown> {
  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        system: system ?? "You are a precise classifier. Respond with ONLY a single JSON object, no commentary.",
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama returned ${res.status}`);
    const body = (await res.json()) as { response?: string };
    return extractJson(body.response ?? "");
  } catch (err) {
    await logError("ai", "generateJson failed", { error: String(err) });
    return null;
  }
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function ollamaHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface AiHealth {
  /** Ollama server is reachable. */
  reachable: boolean;
  /** The configured model is actually pulled and listed by the server. */
  modelPresent: boolean;
  model: string;
  /** Fraction of recent AI calls that returned valid JSON (null if none yet). */
  recentValidRate: number | null;
  recentSamples: number;
  /** Timestamp of the last valid AI decision, or null if none on record. */
  lastValidAt: string | null;
}

/**
 * Truthful AI status: not just "is the server up" but "is the configured
 * model present" and "have recent calls actually produced valid output".
 * A reachable server with a missing model, or a model that keeps returning
 * garbage, both mean the AI is effectively DOWN — and the bot vetoes every
 * trade. This surfaces that instead of letting it look healthy.
 */
export async function aiHealth(): Promise<AiHealth> {
  let reachable = false;
  let modelPresent = false;
  const base = (s: string) => s.split(":")[0];
  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      reachable = true;
      const body = (await res.json()) as { models?: { name?: string }[] };
      const names = (body.models ?? []).map((m) => m.name ?? "");
      modelPresent = names.includes(config.OLLAMA_MODEL) || names.some((n) => base(n) === base(config.OLLAMA_MODEL));
    }
  } catch {
    /* unreachable — reachable stays false */
  }

  const recent = await prisma.aiAnalysisLog.findMany({
    orderBy: { createdAt: "desc" }, take: 20, select: { valid: true, createdAt: true },
  });
  const valids = recent.filter((r) => r.valid);
  return {
    reachable,
    modelPresent,
    model: config.OLLAMA_MODEL,
    recentValidRate: recent.length ? Number((valids.length / recent.length).toFixed(2)) : null,
    recentSamples: recent.length,
    lastValidAt: valids[0]?.createdAt.toISOString() ?? null,
  };
}
