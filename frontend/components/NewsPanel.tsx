"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconClock, IconInfo, IconNews, IconRefresh, IconX } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";

type NewsFilter = "all" | "calendar" | "headline" | "HIGH" | "MEDIUM" | "LOW";

interface NewsEvent {
  id: string;
  title: string;
  country?: string | null;
  currency: string | null;
  impact: "LOW" | "MEDIUM" | "HIGH" | string;
  eventTime: string;
  forecast?: string | null;
  previous?: string | null;
  source: string;
  raw?: unknown;
  createdAt?: string;
}

interface Risk {
  level: "low" | "medium" | "high" | string;
  action: "allow" | "reduce" | "pause" | string;
  reason: string;
  upcomingEvents?: { title: string; impact: string; currency: string | null; eventTime: string }[];
}

const FILTERS: { key: NewsFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "HIGH", label: "High" },
  { key: "MEDIUM", label: "Medium" },
  { key: "LOW", label: "Low" },
  { key: "headline", label: "Headlines" },
  { key: "calendar", label: "Calendar" },
];

const IMPACT_STYLES: Record<string, { chip: string; border: string; dot: string }> = {
  HIGH: { chip: "bg-red-950 text-down", border: "border-red-900/50", dot: "bg-down" },
  MEDIUM: { chip: "bg-amber-950 text-warn", border: "border-amber-900/40", dot: "bg-warn" },
  LOW: { chip: "bg-surface-3 text-ink-dim", border: "border-line", dot: "bg-ink-faint" },
};

export function NewsPanel() {
  const toast = useToast();
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [symbol, setSymbol] = useState("EURUSD");
  const [risk, setRisk] = useState<Risk | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<NewsFilter>("all");
  const [selected, setSelected] = useState<NewsEvent | null>(null);

  const load = useCallback(async () => {
    try { setEvents(await api<NewsEvent[]>("/api/news")); } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function checkRisk() {
    try { setRisk(await api<Risk>(`/api/news/risk/${symbol}`)); } catch { /* noop */ }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await api("/api/news/refresh", { method: "POST" });
      await load();
      toast.success("News refreshed", "The economic calendar and market headlines are up to date.");
    } catch (err) {
      toast.error("News refresh failed", err instanceof Error ? err.message : "The latest news could not be loaded.");
    } finally { setRefreshing(false); }
  }

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const highCount = events.filter((e) => e.impact === "HIGH").length;
  const headlineCount = events.filter(isHeadline).length;
  const calendarCount = events.length - headlineCount;
  const nextHigh = events.find((e) => e.impact === "HIGH" && new Date(e.eventTime).getTime() >= Date.now());
  const visible = events.filter((event) => {
    if (filter === "all") return true;
    if (filter === "headline") return isHeadline(event);
    if (filter === "calendar") return !isHeadline(event);
    return event.impact === filter;
  });

  return (
    <div className="space-y-6">
      <section className="card">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title !mb-1">
              <IconNews size={15} />
              Market news radar
            </h2>
            <p className="text-xs text-ink-faint">Economic calendar events and classified market headlines used by the risk gate.</p>
          </div>
          <button onClick={refresh} disabled={refreshing} className="btn-ghost btn-sm">
            <IconRefresh size={13} className={refreshing ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <NewsMetric label="Loaded" value={events.length} />
          <NewsMetric label="Calendar" value={calendarCount} />
          <NewsMetric label="High impact" value={highCount} tone={highCount > 0 ? "down" : undefined} />
          <NewsMetric label="Headlines" value={headlineCount} />
          <NewsMetric label="Next high" value={nextHigh ? relativeTime(nextHigh.eventTime) : "none"} tone={nextHigh ? "warn" : undefined} />
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          {FILTERS.map((item) => {
            const active = filter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={`btn-sm rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  active ? "border-primary/70 bg-primary-dim/20 text-primary" : "border-line bg-surface-2 text-ink-dim hover:bg-surface-3 hover:text-ink"
                }`}
              >
                {item.label}
              </button>
            );
          })}
          <span className="ml-auto self-center text-xs text-ink-faint">{visible.length} shown</span>
        </div>

        {events.length === 0 && <p className="py-6 text-center text-sm text-ink-faint">No events loaded — hit Refresh.</p>}
        {events.length > 0 && visible.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-faint">No news matches this filter.</p>
        )}
        <div className="max-h-[32rem] space-y-2 overflow-auto pr-1">
          {visible.map((event) => (
            <button
              key={event.id}
              type="button"
              onClick={() => setSelected(event)}
              title="View full news details"
              aria-label={`View details for ${event.title}`}
              className={`w-full rounded-xl border bg-surface-2/60 px-3 py-3 text-left transition-colors hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${impactStyle(event.impact).border}`}
            >
              <div className="flex items-start gap-3">
                <ImpactBadge impact={event.impact} />
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="tnum inline-flex items-center gap-1 text-xs text-ink-faint">
                      <IconClock size={11} /> {formatDate(event.eventTime)}
                    </span>
                    <span className="chip bg-bg !px-2 !py-0.5 font-mono !text-[10px] text-ink-dim">{currencies(event)}</span>
                    <span className="chip bg-bg !px-2 !py-0.5 !text-[10px] text-ink-faint">{sourceLabel(event)}</span>
                  </div>
                  <p className="break-words text-sm font-medium leading-snug text-ink">{event.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-dim">{eventSummary(event)}</p>
                </div>
                <IconInfo size={14} className="mt-1 shrink-0 text-ink-faint" />
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="mb-4">
          <h2 className="section-title !mb-1">Symbol news risk</h2>
          <p className="text-xs text-ink-faint">Checks the same calendar/headline window the trading pipeline uses before opening a trade.</p>
        </div>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void checkRisk();
          }}
        >
          <label htmlFor="risk-symbol" className="sr-only">Symbol</label>
          <input id="risk-symbol" className="input !w-36 font-mono" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          <button className="btn-primary">Check risk</button>
        </form>
        {risk && (
          <div className="mt-4 rounded-xl border border-line bg-surface-2 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`chip ${risk.level === "high" ? "bg-red-950 text-down" : risk.level === "medium" ? "bg-amber-950 text-warn" : "bg-emerald-950 text-up"}`}>
                {risk.level.toUpperCase()}
              </span>
              <span className="text-xs uppercase text-ink-faint">Action</span>
              <span className="font-semibold uppercase text-ink">{risk.action}</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-dim">{risk.reason}</p>
            {!!risk.upcomingEvents?.length && (
              <div className="mt-4 border-t border-line pt-3">
                <h3 className="mb-2 text-xs font-semibold uppercase text-ink-dim">Upcoming high-impact events</h3>
                <div className="space-y-2">
                  {risk.upcomingEvents.map((event, index) => (
                    <div key={`${event.title}-${event.eventTime}-${index}`} className="flex items-start gap-2 rounded-lg bg-bg px-3 py-2">
                      <ImpactDot impact={event.impact} />
                      <div className="min-w-0">
                        <p className="break-words text-xs font-medium text-ink">{event.title}</p>
                        <p className="tnum mt-0.5 text-[10px] text-ink-faint">{event.currency ?? "Global"} · {formatDate(event.eventTime)} · {relativeTime(event.eventTime)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {selected && <NewsDetailModal event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ImpactDot({ impact }: { impact: string }) {
  const color = impactStyle(impact).dot;
  return (
    <span className="flex w-12 shrink-0 items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
      <span className="text-[10px] uppercase text-ink-faint">{impact.toLowerCase()}</span>
    </span>
  );
}

function ImpactBadge({ impact }: { impact: string }) {
  const style = impactStyle(impact);
  return (
    <span className={`chip shrink-0 !px-2 !py-1 !text-[10px] uppercase ${style.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {impact.toLowerCase()}
    </span>
  );
}

function NewsMetric({ label, value, tone }: { label: string; value: string | number; tone?: "warn" | "down" }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
      <p className="text-[10px] uppercase text-ink-faint">{label}</p>
      <p className={`tnum mt-1 text-sm font-semibold ${tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-ink"}`}>{value}</p>
    </div>
  );
}

function NewsDetailModal({ event, onClose }: { event: NewsEvent; onClose: () => void }) {
  const raw = rawObject(event);
  const classificationReason = typeof raw.reason === "string" ? raw.reason : "";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="news-detail-title"
        className="card max-h-[84vh] w-full max-w-2xl overflow-auto"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <ImpactBadge impact={event.impact} />
              <span className="chip bg-surface-3 !px-2 !py-0.5 !text-[10px] text-ink-faint">{sourceLabel(event)}</span>
            </div>
            <h3 id="news-detail-title" className="break-words text-base font-semibold leading-snug text-ink">{event.title}</h3>
            <p className="tnum mt-1 text-xs text-ink-faint">{formatDate(event.eventTime)} · {relativeTime(event.eventTime)}</p>
          </div>
          <button
            type="button"
            onClick={(clickEvent) => {
              clickEvent.stopPropagation();
              onClose();
            }}
            aria-label="Close news details"
            className="btn-ghost btn-sm"
          >
            <IconX size={14} />
          </button>
        </div>

        <dl className="mb-4 grid gap-2 text-xs sm:grid-cols-2">
          <DetailItem label="Currencies" value={currencies(event)} />
          <DetailItem label="Source" value={sourceLabel(event)} />
          <DetailItem label="Country" value={event.country ?? "n/a"} />
          <DetailItem label="Event ID" value={event.id} mono />
          {(hasText(event.forecast) || hasText(event.previous)) && (
            <>
              <DetailItem label="Forecast" value={displayValue(event.forecast)} />
              <DetailItem label="Previous" value={displayValue(event.previous)} />
            </>
          )}
          {event.createdAt && <DetailItem label="Stored" value={formatDate(event.createdAt)} />}
        </dl>

        {classificationReason && (
          <div className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-2">
            <h4 className="text-xs font-semibold uppercase text-ink-dim">AI classification</h4>
            <p className="mt-1 text-xs leading-relaxed text-ink-dim">{classificationReason}</p>
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase text-ink-dim">Raw payload</h4>
            <span className="text-[10px] text-ink-faint">JSON</span>
          </div>
          <pre className="max-h-[36vh] overflow-auto rounded-lg border border-line bg-bg p-3 text-xs leading-relaxed text-ink-dim">{JSON.stringify(raw, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}

function DetailItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <dt className="mb-1 text-[10px] uppercase text-ink-faint">{label}</dt>
      <dd className={`break-words text-ink-dim ${mono ? "break-all font-mono" : "font-medium"}`}>{value}</dd>
    </div>
  );
}

function impactStyle(impact: string) {
  return IMPACT_STYLES[impact] ?? IMPACT_STYLES.LOW;
}

function isHeadline(event: NewsEvent): boolean {
  return event.source.startsWith("headline:");
}

function sourceLabel(event: NewsEvent): string {
  if (isHeadline(event)) return event.source.replace(/^headline:/, "").replace(/^www\./, "");
  if (event.source === "forexfactory") return "ForexFactory";
  return event.source || "calendar";
}

function rawObject(event: NewsEvent): Record<string, unknown> {
  if (event.raw && typeof event.raw === "object" && !Array.isArray(event.raw)) {
    return event.raw as Record<string, unknown>;
  }
  return {};
}

function currencies(event: NewsEvent): string {
  const raw = rawObject(event);
  const listed = Array.isArray(raw.currencies) ? raw.currencies.filter((value): value is string => typeof value === "string") : [];
  if (listed.length) return listed.join(", ");
  return event.currency ?? "Global";
}

function eventSummary(event: NewsEvent): string {
  const raw = rawObject(event);
  if (typeof raw.reason === "string" && raw.reason.trim()) return raw.reason;
  if (hasText(event.forecast) || hasText(event.previous)) return `Forecast ${displayValue(event.forecast)} · Previous ${displayValue(event.previous)}`;
  if (event.country && event.country !== event.currency) return event.country;
  return isHeadline(event) ? "Classified headline" : "Economic calendar event";
}

function hasText(value?: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function displayValue(value?: string | null): string {
  return typeof value === "string" && value.trim() ? value.trim() : "n/a";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function relativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "unknown";
  const minutes = Math.round((time - Date.now()) / 60_000);
  if (Math.abs(minutes) < 1) return "now";
  const suffix = minutes > 0 ? "from now" : "ago";
  const abs = Math.abs(minutes);
  if (abs < 60) return `${abs}m ${suffix}`;
  const hours = Math.round(abs / 60);
  if (hours < 48) return `${hours}h ${suffix}`;
  return `${Math.round(hours / 24)}d ${suffix}`;
}
