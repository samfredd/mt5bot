"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconX } from "@/components/icons";

interface Strategy { id: string; name: string; type: string; enabled: boolean; config: Record<string, unknown> }
interface Preset { name: string; type: string; config: Record<string, unknown> }

export function StrategiesPanel() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [configText, setConfigText] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      setStrategies(await api<Strategy[]>("/api/strategies"));
      setPresets(await api<Preset[]>("/api/strategies/presets"));
    } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function addPreset(p: Preset) {
    setMessage("");
    try { await api("/api/strategies", { method: "POST", body: p }); await load(); }
    catch (err) { setMessage(err instanceof Error ? err.message : "failed"); }
  }

  async function toggle(s: Strategy) {
    try { await api(`/api/strategies/${s.id}`, { method: "PUT", body: { enabled: !s.enabled } }); await load(); }
    catch (err) { setMessage(err instanceof Error ? err.message : "failed"); }
  }

  async function saveConfig() {
    if (!editing) return;
    try {
      const config = JSON.parse(configText);
      await api(`/api/strategies/${editing.id}`, { method: "PUT", body: { config } });
      setEditing(null);
      await load();
    } catch (err) { setMessage(err instanceof Error ? err.message : "invalid JSON or rejected by server"); }
  }

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="section-title">My strategies</h2>
        {strategies.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-faint">No strategies yet — add a preset below, then enable it.</p>
        )}
        <div className="space-y-2">
          {strategies.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm">
              <div className="flex items-center gap-2.5">
                <span className={`h-2 w-2 rounded-full ${s.enabled ? "bg-up" : "bg-ink-faint"}`} aria-hidden />
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-ink-faint">{s.type.replace(/_/g, " ")}</span>
                <span className={`chip !text-[10px] ${s.enabled ? "bg-emerald-950 text-up" : "bg-surface-3 text-ink-faint"}`}>
                  {s.enabled ? "Active" : "Off"}
                </span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setEditing(s); setConfigText(JSON.stringify(s.config, null, 2)); }} className="btn-ghost btn-sm">Configure</button>
                <button onClick={() => toggle(s)}
                  className={`btn btn-sm ${s.enabled ? "bg-amber-950 text-amber-300 ring-1 ring-amber-900 hover:bg-amber-900" : "bg-emerald-900 text-emerald-100 hover:bg-emerald-800"}`}>
                  {s.enabled ? "Disable" : "Enable"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="section-title">Preset strategies</h2>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p.name} onClick={() => addPreset(p)} className="btn-ghost">+ {p.name}</button>
          ))}
        </div>
      </section>

      {message && <p className="text-sm text-warn" role="status">{message}</p>}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setEditing(null)}>
          <div className="card w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-base font-semibold">Configure: {editing.name}</h3>
              <button onClick={() => setEditing(null)} aria-label="Close" className="btn-ghost btn-sm"><IconX size={14} /></button>
            </div>
            <p className="mb-3 text-xs text-ink-dim">Symbols, timeframes, entry/exit rules, lot sizing, sessions, news behavior — validated server-side.</p>
            <textarea aria-label="Strategy configuration JSON" className="input tnum h-80 resize-y !rounded-xl font-mono !text-xs"
              value={configText} onChange={(e) => setConfigText(e.target.value)} />
            <div className="mt-3 flex gap-2">
              <button onClick={saveConfig} className="btn-primary">Save</button>
              <button onClick={() => setEditing(null)} className="btn-ghost">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
