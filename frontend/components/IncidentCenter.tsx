"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ToastProvider";

interface Incident {
  id: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  title: string;
  message: string;
  source: string;
  occurrenceCount: number;
  lastSeenAt: string;
}

export function IncidentCenter({ refreshKey = 0 }: { refreshKey?: number }) {
  const toast = useToast();
  const [items, setItems] = useState<Incident[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<Incident[]>("/api/incidents?status=ACTIVE&limit=30").then((rows) => { setItems(rows); setError(""); }).catch((err) => setError(String(err))), []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const act = async (id: string, action: "acknowledge" | "resolve") => {
    try {
      await api(`/api/incidents/${id}/${action}`, { method: "POST", body: {} });
      await load();
      toast.success(action === "resolve" ? "Incident resolved" : "Incident acknowledged", "The incident center has been updated.");
    } catch (err) {
      toast.error("Incident not updated", err instanceof Error ? err.message : "The action could not be completed.");
    }
  };
  return (
    <section className="panel">
      <div className="mb-4 flex items-center justify-between"><div><p className="eyebrow">Operations</p><h2 className="text-lg font-semibold">Incident center</h2></div><button className="btn-ghost text-xs" onClick={() => void load()}>Refresh</button></div>
      {error && <p className="text-sm text-down">Could not load incidents: {error}</p>}
      {!error && items === null && <p className="text-sm text-ink-faint">Loading incidents...</p>}
      {!error && items?.length === 0 && <p className="text-sm text-ink-faint">No incidents recorded.</p>}
      <div className="space-y-2">
        {items?.map((item) => <article key={item.id} className="card !p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="flex items-center gap-2"><span className={`chip ${item.severity === "CRITICAL" ? "bg-red-950 text-down" : item.severity === "WARNING" ? "bg-amber-950 text-warn" : "bg-sky-950 text-sky-300"}`}>{item.severity}</span><span className="chip bg-white/5 text-ink-dim">{item.status}</span><strong className="text-sm">{item.title}</strong></div><p className="mt-2 text-xs text-ink-dim">{item.message}</p><p className="mt-1 text-[11px] text-ink-faint">{item.source} · {item.occurrenceCount} occurrence(s) · {new Date(item.lastSeenAt).toLocaleString()}</p></div>
            <div className="flex gap-2">{item.status === "OPEN" && <button className="btn-ghost text-xs" onClick={() => void act(item.id, "acknowledge")}>Acknowledge</button>}{item.status !== "RESOLVED" && <button className="btn-ghost text-xs" onClick={() => void act(item.id, "resolve")}>Resolve</button>}</div>
          </div>
        </article>)}
      </div>
    </section>
  );
}
