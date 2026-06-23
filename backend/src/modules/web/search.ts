import { config } from "../../config.js";
import { logError } from "../../lib/audit.js";
import { CircuitOpenError, circuitSnapshot, withResilience } from "../../lib/resilience.js";
import { reportIncident, resolveIncidentByDedupeKey } from "../incidents/service.js";

/**
 * Web search for the Strategy Lab's "latest internet resources" context.
 * Provider-agnostic (Tavily by default, Serper/Google supported). When no API
 * key is set it cleanly returns nothing, so the Lab still works on RSS + the
 * economic calendar alone. Results are CONTEXT for idea generation only — the
 * backtest gate still judges every proposal, so untrusted web text can never
 * cause a trade.
 */

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

/** Pure gate: a non-empty key enables web search. */
export function shouldSearch(apiKey: string): boolean {
  return apiKey.trim().length > 0;
}

export function webSearchConfigured(): boolean {
  return shouldSearch(config.WEB_SEARCH_API_KEY);
}

export async function webSearch(query: string, maxResults = 5): Promise<WebResult[]> {
  if (!webSearchConfigured()) return [];
  try {
    const results = await withResilience("web-search", () => config.WEB_SEARCH_PROVIDER === "serper"
      ? serper(query, maxResults)
      : tavily(query, maxResults), {
      retries: 2,
      baseDelayMs: 250,
      maxDelayMs: 1000,
      failureThreshold: 3,
      cooldownMs: 60_000,
    });
    await resolveIncidentByDedupeKey("web-search:circuit-open", "system").catch(() => undefined);
    return results;
  } catch (err) {
    await logError("web-search", "search failed", { query: query.slice(0, 100), error: String(err) });
    const state = circuitSnapshot("web-search");
    if (err instanceof CircuitOpenError || (!Array.isArray(state) && state?.status === "open")) {
      await reportIncident({
        dedupeKey: "web-search:circuit-open",
        severity: "WARNING",
        source: "web-search",
        title: "Web search circuit open",
        message: "Strategy research search is temporarily suspended after repeated failures.",
        context: { error: String(err) },
        minIntervalMs: 60_000,
      }).catch(() => undefined);
    }
    return [];
  }
}

async function tavily(query: string, maxResults: number): Promise<WebResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: config.WEB_SEARCH_API_KEY,
      query,
      max_results: maxResults,
      search_depth: "basic",
      topic: "news",
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (body.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: (r.content ?? "").slice(0, 300) }));
}

async function serper(query: string, maxResults: number): Promise<WebResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": config.WEB_SEARCH_API_KEY },
    body: JSON.stringify({ q: query, num: maxResults }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`serper ${res.status}`);
  const body = (await res.json()) as { organic?: { title?: string; link?: string; snippet?: string }[] };
  return (body.organic ?? []).slice(0, maxResults).map((r) => ({ title: r.title ?? "", url: r.link ?? "", snippet: (r.snippet ?? "").slice(0, 300) }));
}
