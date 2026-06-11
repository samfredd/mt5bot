"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconRefresh } from "@/components/icons";

interface NewsEvent { id: string; title: string; currency: string | null; impact: string; eventTime: string; source: string }
interface Risk { level: string; action: string; reason: string }

export function NewsPanel() {
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [symbol, setSymbol] = useState("EURUSD");
  const [risk, setRisk] = useState<Risk | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setEvents(await api<NewsEvent[]>("/api/news")); } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function checkRisk() {
    try { setRisk(await api<Risk>(`/api/news/risk/${symbol}`)); } catch { /* noop */ }
  }

  async function refresh() {
    setRefreshing(true);
    await api("/api/news/refresh", { method: "POST" }).catch(() => {});
    await load();
    setRefreshing(false);
  }

  return (
    <div className="space-y-6">
      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="section-title !mb-0">Calendar & headlines</h2>
          <button onClick={refresh} disabled={refreshing} className="btn-ghost btn-sm">
            <IconRefresh size={13} className={refreshing ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
        {events.length === 0 && <p className="py-6 text-center text-sm text-ink-faint">No events loaded — hit Refresh.</p>}
        <div className="max-h-[28rem] space-y-1 overflow-auto">
          {events.map((e) => (
            <div key={e.id} className="flex items-center gap-3 rounded-lg bg-surface-2/60 px-3 py-2 text-sm">
              <ImpactDot impact={e.impact} />
              <span className="tnum w-28 shrink-0 text-xs text-ink-faint">{new Date(e.eventTime).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="w-10 shrink-0 font-mono text-xs text-ink-dim">{e.currency ?? "—"}</span>
              <span className="min-w-0 truncate">{e.title}</span>
              {e.source.startsWith("headline:") && <span className="chip ml-auto shrink-0 bg-surface-3 !text-[10px] text-ink-faint">headline</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="section-title">Symbol news risk</h2>
        <div className="flex gap-2">
          <label htmlFor="risk-symbol" className="sr-only">Symbol</label>
          <input id="risk-symbol" className="input !w-36" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          <button onClick={checkRisk} className="btn-primary">Check</button>
        </div>
        {risk && (
          <div className="mt-4 rounded-xl bg-surface-2 p-4 text-sm">
            <span className={`chip ${risk.level === "high" ? "bg-red-950 text-down" : risk.level === "medium" ? "bg-amber-950 text-warn" : "bg-emerald-950 text-up"}`}>
              {risk.level.toUpperCase()} → {risk.action.toUpperCase()}
            </span>
            <p className="mt-2 text-xs leading-relaxed text-ink-dim">{risk.reason}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function ImpactDot({ impact }: { impact: string }) {
  const color = impact === "HIGH" ? "bg-down" : impact === "MEDIUM" ? "bg-warn" : "bg-ink-faint";
  return (
    <span className="flex w-12 shrink-0 items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
      <span className="text-[10px] uppercase text-ink-faint">{impact.toLowerCase()}</span>
    </span>
  );
}
