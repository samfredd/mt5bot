"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, WS_URL } from "@/lib/api";
import { IconPause, IconPlay } from "@/components/icons";

interface AuditEvent {
  id?: string;
  actor: string;
  category: string;
  action: string;
  detail: Record<string, unknown>;
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
  if (Array.isArray(d.candidates)) bits.push(`${(d.candidates as unknown[]).length} candidate(s)`);
  if (typeof d.confidence === "number") bits.push(`conf ${(d.confidence as number).toFixed(2)}`);
  if (typeof d.reason === "string") bits.push(String(d.reason).slice(0, 90));
  return bits.join(" · ");
}

export function ActivityPanel() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = useCallback(async () => {
    try {
      setEvents(await api<AuditEvent[]>("/api/audit?limit=80"));
    } catch { /* viewer role can't read audit */ }
  }, []);

  useEffect(() => {
    void load();
    const ws = new WebSocket(WS_URL);
    ws.onmessage = (msg) => {
      if (pausedRef.current) return;
      try {
        const { event, data } = JSON.parse(msg.data);
        if (event === "audit") setEvents((prev) => [data as AuditEvent, ...prev].slice(0, 200));
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, [load]);

  const categories = ["all", ...new Set(events.map((e) => e.category))];
  const visible = filter === "all" ? events : events.filter((e) => e.category === filter);

  return (
    <section className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title !mb-0">
          Live activity
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
          <div key={e.id ?? `${e.createdAt}-${i}`} className="flex items-start gap-2.5 rounded-lg bg-surface-2/60 px-3 py-2 text-xs">
            <span className="tnum mt-0.5 shrink-0 text-ink-faint">{new Date(e.createdAt).toLocaleTimeString()}</span>
            <span className={`chip shrink-0 !px-2 !py-0.5 !text-[10px] uppercase ${CATEGORY_COLORS[e.category] ?? "bg-surface-3 text-ink-dim"}`}>
              {e.category}
            </span>
            <span className="font-medium text-ink">{e.action.replace(/_/g, " ")}</span>
            <span className="min-w-0 truncate text-ink-dim">{summarize(e)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
