import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit, logError } from "../../lib/audit.js";
import { generateJson } from "../ai/service.js";
import { withResilience } from "../../lib/resilience.js";
import { getOperationalConfig } from "../system/operational-config.js";

/**
 * Breaking-news headlines: pulled from financial RSS feeds, classified by
 * the local AI (impact + affected currencies), stored as NewsEvent rows with
 * source "headline:<feed>". They feed the same news gate as the calendar,
 * but more conservatively: a HIGH headline reduces size, it never pauses on
 * its own (calendar events are authoritative; headline classification is
 * best-effort). Classification failure degrades to LOW = no trading effect.
 */

interface RawHeadline {
  title: string;
  publishedAt: Date;
  feed: string;
}

const ClassificationSchema = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      impact: z.enum(["low", "medium", "high"]),
      currencies: z.array(z.string()).max(6),
      reason: z.string().max(300),
    }),
  ),
});

/** Tiny dependency-free RSS <item> parser (title + pubDate). */
export function parseRssItems(xml: string): { title: string; pubDate: string }[] {
  const items: { title: string; pubDate: string }[] = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemBlocks) {
    const rawTitle = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const title = rawTitle
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .trim();
    const pubDate = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? "";
    if (title) items.push({ title, pubDate });
  }
  return items;
}

async function fetchFeed(url: string): Promise<RawHeadline[]> {
  const xml = await withResilience("news", async () => {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (mt5bot news module)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`feed ${url} returned ${res.status}`);
    return res.text();
  }, { retries: 2, baseDelayMs: 250, maxDelayMs: 1000, failureThreshold: 3, cooldownMs: 60_000 });
  const feed = new URL(url).hostname.replace(/^www\./, "");
  return parseRssItems(xml)
    .map((i) => ({
      title: i.title.slice(0, 300),
      publishedAt: i.pubDate ? new Date(i.pubDate) : new Date(),
      feed,
    }))
    .filter((h) => !Number.isNaN(h.publishedAt.getTime()));
}

function classificationPrompt(headlines: RawHeadline[]): string {
  return [
    `Classify each financial news headline for short-term FX/commodity/index trading impact.`,
    `impact: "high" = can move markets immediately (central bank surprises, war/geopolitical shocks, major data surprises, intervention).`,
    `"medium" = notable but not immediately market-moving. "low" = noise, opinion, recaps.`,
    `currencies: ISO codes directly affected (USD, EUR, GBP, JPY, AUD, NZD, CAD, CHF, CNY). Gold/oil/US indices -> USD.`,
    ``,
    ...headlines.map((h, i) => `${i}: ${h.title}`),
    ``,
    `Respond with ONLY JSON: {"items":[{"index":0,"impact":"low|medium|high","currencies":["USD"],"reason":"short reason"}, ...]} covering every index.`,
  ].join("\n");
}

/** Fetch feeds, classify new headlines with the AI, store them. */
export async function refreshHeadlines(): Promise<number> {
  const feeds = (await getOperationalConfig()).newsRssFeeds;
  if (!feeds.length) return 0;

  const all: RawHeadline[] = [];
  for (const url of feeds) {
    try {
      all.push(...(await fetchFeed(url)));
    } catch (err) {
      await logError("news", "headline feed failed", { url, error: String(err) });
    }
  }

  // Keep recent ones we haven't stored yet.
  const cutoff = new Date(Date.now() - 12 * 3600_000);
  const recent = all.filter((h) => h.publishedAt >= cutoff).slice(0, 40);
  const fresh: RawHeadline[] = [];
  for (const h of recent) {
    const exists = await prisma.newsEvent.findFirst({ where: { title: h.title } });
    if (!exists) fresh.push(h);
  }
  if (!fresh.length) return 0;

  // Classify in batches; on failure, store as LOW (visible but inert).
  const classifications = new Map<number, { impact: "LOW" | "MEDIUM" | "HIGH"; currencies: string[]; reason: string }>();
  for (let i = 0; i < fresh.length; i += 10) {
    const batch = fresh.slice(i, i + 10);
    const raw = await generateJson(classificationPrompt(batch));
    const parsed = ClassificationSchema.safeParse(raw);
    if (parsed.success) {
      for (const item of parsed.data.items) {
        if (item.index >= 0 && item.index < batch.length) {
          classifications.set(i + item.index, {
            impact: item.impact.toUpperCase() as "LOW" | "MEDIUM" | "HIGH",
            currencies: item.currencies.map((c) => c.toUpperCase()),
            reason: item.reason,
          });
        }
      }
    }
  }

  let stored = 0;
  for (const [idx, h] of fresh.entries()) {
    const c = classifications.get(idx) ?? { impact: "LOW" as const, currencies: [], reason: "unclassified" };
    try {
      await prisma.newsEvent.upsert({
        where: { title_eventTime: { title: h.title, eventTime: h.publishedAt } },
        create: {
          title: h.title,
          currency: c.currencies[0] ?? null,
          impact: c.impact,
          eventTime: h.publishedAt,
          source: `headline:${h.feed}`,
          raw: { feed: h.feed, currencies: c.currencies, reason: c.reason } as object,
        },
        update: {},
      });
      stored++;
    } catch {
      /* duplicate race — ignore */
    }
  }
  if (stored) {
    await audit({ actor: "system", category: "news", action: "headlines_refreshed", detail: { stored, feeds } });
  }
  return stored;
}

/** Recent HIGH-impact headlines touching the given currencies. */
export async function recentHighImpactHeadlines(currencies: string[], windowHours = 2) {
  const events = await prisma.newsEvent.findMany({
    where: {
      source: { startsWith: "headline:" },
      impact: "HIGH",
      eventTime: { gte: new Date(Date.now() - windowHours * 3600_000) },
    },
    orderBy: { eventTime: "desc" },
    take: 10,
  });
  return events.filter((e) => {
    const evCurrencies = ((e.raw as { currencies?: string[] })?.currencies ?? [e.currency]).filter(Boolean);
    return evCurrencies.some((c) => currencies.includes(c as string));
  });
}
