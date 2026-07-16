import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { generateJson } from "../ai/service.js";
import { webSearch, webSearchConfigured, type WebResult } from "../web/search.js";

const SentimentInput = z.object({
  score: z.number(),
  confidence: z.number(),
  summary: z.string().max(500),
});

type SentimentInputValue = z.infer<typeof SentimentInput>;

export function normalizeSentiment(
  input: SentimentInputValue,
  sources: WebResult[],
  generatedAt: Date,
  now = new Date(),
) {
  const score = Math.max(-1, Math.min(1, input.score));
  const confidence = Math.max(0, Math.min(1, input.confidence));
  return {
    score: Number(score.toFixed(2)),
    label: score > 0.2 ? "bullish" as const : score < -0.2 ? "bearish" as const : "neutral" as const,
    confidence: Number(confidence.toFixed(2)),
    summary: input.summary,
    generatedAt: generatedAt.toISOString(),
    ageSeconds: Math.max(0, Math.floor((now.getTime() - generatedAt.getTime()) / 1000)),
    sources: sources.map((source) => ({ title: source.title, url: source.url })),
  };
}

/**
 * Cache-only sentiment read for the TRADE path: never searches the web, never
 * calls the model, so it adds one DB read of latency to a trade decision.
 * Returns null when there is no reading, the reading is stale, or it carries
 * zero confidence — the decision context then lists sentiment as missing.
 */
export async function cachedSentiment(
  symbol: string,
  maxAgeMinutes = 60,
): Promise<{ score: number; label: string; confidence: number; ageSeconds: number; summary: string } | null> {
  const cached = await prisma.systemSetting.findUnique({ where: { key: `sentiment:${symbol.toUpperCase()}` } });
  if (!cached) return null;
  const value = cached.value as ReturnType<typeof normalizeSentiment>;
  const generatedAt = new Date(value.generatedAt);
  const ageMs = Date.now() - generatedAt.getTime();
  if (Number.isNaN(generatedAt.getTime()) || ageMs > maxAgeMinutes * 60_000 || value.confidence <= 0) return null;
  return {
    score: value.score,
    label: value.label,
    confidence: value.confidence,
    ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
    summary: value.summary,
  };
}

/**
 * Fire-and-forget refresh so the NEXT decision has fresh sentiment without
 * this one paying the web-search + model latency. No-op when web search is
 * not configured (a zero-evidence reading would only pollute the cache).
 */
export function refreshSentimentSoon(symbol: string): void {
  if (!webSearchConfigured()) return;
  void sentimentForSymbol(symbol).catch(() => undefined);
}

export async function sentimentForSymbol(symbol: string) {
  const normalizedSymbol = symbol.toUpperCase();
  const cacheKey = `sentiment:${normalizedSymbol}`;
  const cached = await prisma.systemSetting.findUnique({ where: { key: cacheKey } });
  if (cached) {
    const value = cached.value as ReturnType<typeof normalizeSentiment>;
    const generatedAt = new Date(value.generatedAt);
    if (Date.now() - generatedAt.getTime() < 15 * 60_000) {
      return { ...value, ageSeconds: Math.max(0, Math.floor((Date.now() - generatedAt.getTime()) / 1000)) };
    }
  }

  const generatedAt = new Date();
  const sources = await webSearch(`${normalizedSymbol} market sentiment outlook latest news`, 8);
  let input: SentimentInputValue = {
    score: 0,
    confidence: 0,
    summary: sources.length ? "Sources were found but could not be classified." : "No configured current web-search evidence is available.",
  };
  if (sources.length) {
    const raw = await generateJson([
      `Assess current sentiment for ${normalizedSymbol}.`,
      "Return JSON with score from -1 (bearish) to 1 (bullish), confidence from 0 to 1, and a short factual summary.",
      ...sources.map((source, index) => `${index + 1}. ${source.title}: ${source.snippet}`),
    ].join("\n"));
    const parsed = SentimentInput.safeParse(raw);
    if (parsed.success) input = parsed.data;
  }
  const result = normalizeSentiment(input, sources, generatedAt);
  await prisma.systemSetting.upsert({
    where: { key: cacheKey },
    create: { key: cacheKey, value: result },
    update: { value: result },
  });
  return result;
}
