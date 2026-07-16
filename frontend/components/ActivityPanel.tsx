"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, webSocketProtocols, WS_URL } from "@/lib/api";
import { IconInfo, IconPause, IconPlay, IconX } from "@/components/icons";

interface AuditEvent {
  id?: string;
  userId?: string | null;
  actor: string;
  category: string;
  action: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  trade: "bg-emerald-950 text-up",
  risk: "bg-red-950 text-down",
  ai: "bg-violet-950 text-violet",
  strategy: "bg-sky-950 text-accent",
  news: "bg-amber-950 text-warn",
  mt5: "bg-surface-3 text-ink-dim",
  system: "bg-surface-3 text-ink-dim",
  auth: "bg-surface-3 text-ink-dim",
  copy: "bg-teal-950 text-primary",
  telegram: "bg-blue-950 text-accent",
  whatsapp: "bg-emerald-950 text-up",
};

function summarize(e: AuditEvent): string {
  const d = e.detail ?? {};
  const bits: string[] = [];
  if (typeof d.symbol === "string") bits.push(String(d.symbol));
  if (typeof d.reasoning === "string") bits.push(String(d.reasoning).slice(0, 110));
  if (Array.isArray(d.reasons)) bits.push(String(d.reasons[d.reasons.length - 1] ?? "").slice(0, 110));
  if (Array.isArray(d.failed)) bits.push(`failed: ${(d.failed as string[]).join(", ")}`.slice(0, 100));
  if (Array.isArray(d.candidates)) bits.push(`${(d.candidates as unknown[]).length} pre-AI candidate(s)`);
  if (typeof d.ai === "string") bits.push(`AI ${d.ai}`);
  if (typeof d.requiredConfidence === "number") bits.push(`needs ${d.requiredConfidence.toFixed(2)}`);
  if (typeof d.aiMode === "string") bits.push(String(d.aiMode).toLowerCase());
  if (typeof d.blockedExecution === "boolean") bits.push(d.blockedExecution ? "blocked execution" : "advisory only");
  if (typeof d.confidence === "number") bits.push(`conf ${(d.confidence as number).toFixed(2)}`);
  if (typeof d.reason === "string") bits.push(String(d.reason).slice(0, 90));
  return bits.join(" · ");
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Live audit feed. By default it shows every category (dashboard "Activity"
 * tab). Pass `eventFilter` to scope it to a subsystem (e.g. the Scalping page
 * passes a predicate that keeps only scalping events); when filtered it seeds
 * from a deeper history so the scoped list isn't starved.
 */
export function ActivityPanel({
  title = "Live activity",
  eventFilter,
  seedLimit,
}: {
  title?: string;
  eventFilter?: (e: AuditEvent) => boolean;
  seedLimit?: number;
} = {}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = useCallback(async () => {
    try {
      const limit = seedLimit ?? (eventFilter ? 300 : 80);
      const rows = await api<AuditEvent[]>(`/api/audit?limit=${limit}`);
      setEvents(eventFilter ? rows.filter(eventFilter) : rows);
    } catch { /* viewer role can't read audit */ }
  }, [eventFilter, seedLimit]);

  useEffect(() => {
    void load();
    const ws = new WebSocket(WS_URL, webSocketProtocols());
    ws.onmessage = (msg) => {
      if (pausedRef.current) return;
      try {
        const { event, data } = JSON.parse(msg.data);
        if (event !== "audit") return;
        const ev = data as AuditEvent;
        if (eventFilter && !eventFilter(ev)) return;
        setEvents((prev) => [ev, ...prev].slice(0, 200));
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, [load, eventFilter]);

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const categories = ["all", ...new Set(events.map((e) => e.category))];
  const visible = filter === "all" ? events : events.filter((e) => e.category === filter);

  return (
    <section className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title !mb-0">
          {title}
          <span className="relative flex h-2 w-2">
            <span className="absolute h-full w-full animate-ping rounded-full bg-up opacity-60" />
            <span className="h-2 w-2 rounded-full bg-up" />
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <label htmlFor="activity-filter" className="sr-only">Filter by category</label>
          <select id="activity-filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="input !w-auto cursor-pointer !py-1.5 !text-xs">
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button onClick={() => setPaused(!paused)} className="btn-ghost btn-sm">
            {paused ? <><IconPlay size={12} /> Resume</> : <><IconPause size={12} /> Pause</>}
          </button>
        </div>
      </div>
      <div className="max-h-[34rem] space-y-1 overflow-auto">
        {visible.length === 0 && (
          <p className="py-8 text-center text-sm text-ink-faint">No activity yet — events stream here live as the bot works.</p>
        )}
        {visible.map((e, i) => (
          <button
            key={e.id ?? `${e.createdAt}-${i}`}
            type="button"
            onClick={() => setSelected(e)}
            className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border border-transparent bg-surface-2/60 px-3 py-2 text-left text-xs transition-colors hover:border-line-strong hover:bg-surface-3/80 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            title="View full activity details"
            aria-label={`View details for ${e.action.replace(/_/g, " ")} at ${formatDate(e.createdAt)}`}
          >
            <span className="tnum mt-0.5 shrink-0 text-ink-faint">{new Date(e.createdAt).toLocaleTimeString()}</span>
            <span className={`chip shrink-0 !px-2 !py-0.5 !text-[10px] uppercase ${CATEGORY_COLORS[e.category] ?? "bg-surface-3 text-ink-dim"}`}>
              {e.category}
            </span>
            <span className="font-medium text-ink">{e.action.replace(/_/g, " ")}</span>
            <span className="min-w-0 flex-1 truncate text-ink-dim">{summarize(e) || "Open for full event detail"}</span>
            <IconInfo size={13} className="mt-0.5 shrink-0 text-ink-faint" />
          </button>
        ))}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="activity-detail-title"
            className="card max-h-[82vh] w-full max-w-2xl overflow-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={`chip mb-2 !px-2 !py-0.5 !text-[10px] uppercase ${CATEGORY_COLORS[selected.category] ?? "bg-surface-3 text-ink-dim"}`}>
                  {selected.category}
                </p>
                <h3 id="activity-detail-title" className="break-words text-base font-semibold text-ink">
                  {selected.action.replace(/_/g, " ")}
                </h3>
                <p className="mt-1 text-xs text-ink-faint">{formatDate(selected.createdAt)}</p>
              </div>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelected(null);
                }}
                aria-label="Close activity details"
                className="btn-ghost btn-sm"
              >
                <IconX size={14} />
              </button>
            </div>

            <dl className="mb-4 grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="mb-1 text-[10px] uppercase text-ink-faint">Actor</dt>
                <dd className="break-words font-medium text-ink">{selected.actor || "system"}</dd>
              </div>
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="mb-1 text-[10px] uppercase text-ink-faint">Event ID</dt>
                <dd className="break-all font-mono text-ink-dim">{selected.id ?? "streamed event"}</dd>
              </div>
              {selected.userId && (
                <div className="rounded-lg bg-surface-2 px-3 py-2 sm:col-span-2">
                  <dt className="mb-1 text-[10px] uppercase text-ink-faint">User ID</dt>
                  <dd className="break-all font-mono text-ink-dim">{selected.userId}</dd>
                </div>
              )}
            </dl>

            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase text-ink-dim">Detail payload</h4>
                <span className="text-[10px] text-ink-faint">JSON</span>
              </div>
              <pre className="max-h-[42vh] overflow-auto rounded-lg border border-line bg-bg p-3 text-xs leading-relaxed text-ink-dim">{JSON.stringify(selected.detail ?? {}, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
