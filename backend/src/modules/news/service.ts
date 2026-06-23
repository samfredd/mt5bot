import { config } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { audit, logError } from "../../lib/audit.js";
import type { NewsImpact, RiskSettings } from "@prisma/client";
import { CircuitOpenError, circuitSnapshot, withResilience } from "../../lib/resilience.js";
import { reportIncident, resolveIncidentByDedupeKey } from "../incidents/service.js";

export interface NewsRiskAssessment {
  level: "low" | "medium" | "high";
  action: "allow" | "reduce" | "pause";
  reason: string;
  upcomingEvents: { title: string; impact: string; currency: string | null; eventTime: string }[];
}

interface FfEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast?: string;
  previous?: string;
}

/** Map a symbol like EURUSD / XAUUSD / US30 to the currencies it cares about. */
export function relevantCurrencies(symbol: string): string[] {
  const s = symbol.toUpperCase();
  const known = ["EUR", "USD", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "CNY"];
  const found = known.filter((c) => s.includes(c));
  if (s.startsWith("XAU") || s.startsWith("XAG") || /US30|NAS100|SPX|US500/.test(s)) found.push("USD");
  return [...new Set(found.length ? found : ["USD"])];
}

function mapImpact(raw: string): NewsImpact {
  const v = raw.toLowerCase();
  if (v.includes("high")) return "HIGH";
  if (v.includes("medium")) return "MEDIUM";
  return "LOW";
}

/** Pull the weekly economic calendar and upsert into the database. */
export async function refreshCalendar(): Promise<number> {
  try {
    const events = await withResilience("news", async () => {
      const res = await fetch(config.NEWS_CALENDAR_URL, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`calendar fetch failed: ${res.status}`);
      return await res.json() as FfEvent[];
    }, { retries: 2, baseDelayMs: 250, maxDelayMs: 1000, failureThreshold: 3, cooldownMs: 60_000 });
    await resolveIncidentByDedupeKey("news:circuit-open", "system").catch(() => undefined);
    let stored = 0;
    for (const e of events) {
      if (!e.title || !e.date) continue;
      const eventTime = new Date(e.date);
      if (Number.isNaN(eventTime.getTime())) continue;
      await prisma.newsEvent.upsert({
        where: { title_eventTime: { title: e.title, eventTime } },
        create: {
          title: e.title,
          country: e.country,
          currency: e.country,
          impact: mapImpact(e.impact ?? "low"),
          eventTime,
          forecast: e.forecast,
          previous: e.previous,
          source: "forexfactory",
          raw: e as unknown as object,
        },
        update: { impact: mapImpact(e.impact ?? "low"), forecast: e.forecast },
      });
      stored++;
    }
    await audit({ actor: "system", category: "news", action: "calendar_refreshed", detail: { stored } });
    return stored;
  } catch (err) {
    await logError("news", "calendar refresh failed", { error: String(err) });
    const state = circuitSnapshot("news");
    if (err instanceof CircuitOpenError || (!Array.isArray(state) && state?.status === "open")) {
      await reportIncident({
        dedupeKey: "news:circuit-open",
        severity: "WARNING",
        source: "news",
        title: "News calendar circuit open",
        message: "Calendar refresh is temporarily suspended after repeated failures.",
        context: { error: String(err) },
        minIntervalMs: 60_000,
      }).catch(() => undefined);
    }
    return 0;
  }
}

/**
 * Core news gate used by the trade pipeline: looks at high/medium impact
 * events near "now" for the symbol's currencies and decides whether trading
 * should continue, reduce risk, or pause.
 */
export async function assessNewsRisk(
  symbol: string,
  risk: Pick<RiskSettings, "pauseBeforeNewsMin" | "pauseAfterNewsMin" | "newsRiskLimit" | "allowNewsTrading">,
): Promise<NewsRiskAssessment> {
  const currencies = relevantCurrencies(symbol);
  const now = Date.now();
  const windowStart = new Date(now - risk.pauseAfterNewsMin * 60_000);
  const windowEnd = new Date(now + risk.pauseBeforeNewsMin * 60_000);

  const nearby = await prisma.newsEvent.findMany({
    where: {
      eventTime: { gte: windowStart, lte: windowEnd },
      currency: { in: currencies },
    },
    orderBy: { eventTime: "asc" },
  });

  const upcoming = await prisma.newsEvent.findMany({
    where: {
      eventTime: { gte: new Date(now), lte: new Date(now + 24 * 3600_000) },
      currency: { in: currencies },
      impact: "HIGH",
    },
    orderBy: { eventTime: "asc" },
    take: 5,
  });

  const upcomingEvents = upcoming.map((e) => ({
    title: e.title,
    impact: e.impact,
    currency: e.currency,
    eventTime: e.eventTime.toISOString(),
  }));

  // Calendar events only — headlines are handled separately below.
  const calendarNearby = nearby.filter((e) => !e.source.startsWith("headline:"));
  const high = calendarNearby.filter((e) => e.impact === "HIGH");
  const medium = calendarNearby.filter((e) => e.impact === "MEDIUM");

  if (high.length > 0) {
    const allowed = risk.allowNewsTrading;
    return {
      level: "high",
      action: allowed ? "reduce" : "pause",
      reason: `High-impact event in window: ${high[0].title} (${high[0].currency}) at ${high[0].eventTime.toISOString()}${allowed ? " — news trading explicitly allowed, reducing size" : ""}`,
      upcomingEvents,
    };
  }
  if (medium.length > 0) {
    const block = risk.newsRiskLimit === "LOW";
    return {
      level: "medium",
      action: block ? "pause" : "reduce",
      reason: `Medium-impact event in window: ${medium[0].title} (${medium[0].currency})`,
      upcomingEvents,
    };
  }

  // Breaking-news headlines: a recent HIGH-classified headline reduces size.
  // Headlines never pause on their own — classification is best-effort.
  const { recentHighImpactHeadlines } = await import("./headlines.js");
  const hotHeadlines = await recentHighImpactHeadlines(currencies, 2);
  if (hotHeadlines.length > 0) {
    return {
      level: "medium",
      action: "reduce",
      reason: `Breaking news (last 2h): "${hotHeadlines[0].title}" — reducing size`,
      upcomingEvents,
    };
  }

  return { level: "low", action: "allow", reason: "No impactful events or breaking news in the window.", upcomingEvents };
}

export async function latestNews(limit = 20) {
  return prisma.newsEvent.findMany({
    where: { eventTime: { gte: new Date(Date.now() - 24 * 3600_000) } },
    orderBy: { eventTime: "asc" },
    take: limit,
  });
}
