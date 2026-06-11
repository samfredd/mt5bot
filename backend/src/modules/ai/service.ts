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
export async function askModel(prompt: string, symbol: string): Promise<{ decision: AiDecision; logId: string }> {
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
  return { decision, logId: log.id };
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
