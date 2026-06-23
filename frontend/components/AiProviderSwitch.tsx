"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface ProviderInfo {
  name: string;
  model: string;
  baseUrl: string;
  requiresKey: boolean;
  hasKey: boolean;
  configured: boolean;
  keySource: "db" | "env" | "none";
}
interface ProviderState { active: string; providers: ProviderInfo[] }

const LABELS: Record<string, string> = {
  ollama: "Ollama (local)",
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};
const SHOWS_BASE_URL = new Set(["ollama", "openai", "openrouter"]);
const MODEL_HINT: Record<string, string> = {
  ollama: "e.g. gemma4:12b",
  anthropic: "e.g. claude-3-5-sonnet-latest",
  openai: "e.g. gpt-4o-mini",
  openrouter: "e.g. anthropic/claude-3.5-sonnet",
};

type Draft = { model: string; baseUrl: string; apiKey: string };

export function AiProviderSwitch() {
  const [state, setState] = useState<ProviderState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const apply = useCallback((next: ProviderState) => {
    setState(next);
    setDrafts(Object.fromEntries(next.providers.map((p) => [p.name, { model: p.model, baseUrl: p.baseUrl, apiKey: "" }])));
  }, []);

  const load = useCallback(async () => {
    try { apply(await api<ProviderState>("/api/ai/provider")); } catch { /* noop */ }
  }, [apply]);
  useEffect(() => { void load(); }, [load]);

  if (!state) return null;
  const setDraft = (name: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [name]: { ...d[name], ...patch } }));

  async function switchTo(provider: string) {
    if (provider === state!.active) return;
    setMessage(""); setBusy(`switch:${provider}`);
    try { apply(await api<ProviderState>("/api/ai/provider", { method: "PUT", body: { provider } })); setMessage(`Now using ${LABELS[provider] ?? provider}.`); }
    catch (err) { setMessage(err instanceof Error ? err.message : "switch failed"); }
    finally { setBusy(""); }
  }

  async function saveConfig(p: ProviderInfo) {
    const d = drafts[p.name];
    setMessage(""); setBusy(`save:${p.name}`);
    try {
      const body: Record<string, unknown> = { provider: p.name, model: d.model };
      if (SHOWS_BASE_URL.has(p.name)) body.baseUrl = d.baseUrl;
      if (d.apiKey.trim()) body.apiKey = d.apiKey.trim();
      apply(await api<ProviderState>("/api/ai/provider-config", { method: "PUT", body }));
      setMessage(`${LABELS[p.name] ?? p.name} saved.`);
    } catch (err) { setMessage(err instanceof Error ? err.message : "save failed"); }
    finally { setBusy(""); }
  }

  async function clearKey(p: ProviderInfo) {
    setMessage(""); setBusy(`clear:${p.name}`);
    try { apply(await api<ProviderState>("/api/ai/provider-config", { method: "PUT", body: { provider: p.name, clearKey: true } })); setMessage(`${LABELS[p.name] ?? p.name} key cleared.`); }
    catch (err) { setMessage(err instanceof Error ? err.message : "clear failed"); }
    finally { setBusy(""); }
  }

  return (
    <section className="card">
      <h2 className="section-title">AI provider</h2>
      <p className="mb-4 text-xs text-ink-dim">
        Exactly one provider is used for trade vetting and research — no co-working. Configure keys/models here
        (saved encrypted in the database) and switch live, no restart or <code>.env</code> editing needed.
      </p>

      <div className="space-y-3">
        {state.providers.map((p) => {
          const d = drafts[p.name] ?? { model: "", baseUrl: "", apiKey: "" };
          const isActive = p.name === state.active;
          return (
            <div key={p.name} className={`rounded-xl border p-3 ${isActive ? "border-primary/60 bg-primary-dim/10" : "border-line bg-surface-2"}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">{LABELS[p.name] ?? p.name}</span>
                {isActive
                  ? <span className="chip bg-emerald-950 text-up">active</span>
                  : <span className={`chip ${p.configured ? "bg-surface-3 text-ink-dim" : "bg-amber-950 text-warn"}`}>{p.configured ? "ready" : "not configured"}</span>}
                {p.requiresKey && <span className="chip bg-surface-3 text-ink-faint">{p.hasKey ? `key set (${p.keySource})` : "no key"}</span>}
                {!isActive && p.configured && (
                  <button onClick={() => void switchTo(p.name)} disabled={!!busy} className="btn-ghost ml-auto !px-2.5 !py-1 text-xs">Use this</button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="label">Model</span>
                  <input className="input" value={d.model} placeholder={MODEL_HINT[p.name]} onChange={(e) => setDraft(p.name, { model: e.target.value })} />
                </label>
                {SHOWS_BASE_URL.has(p.name) && (
                  <label className="block">
                    <span className="label">{p.name === "ollama" ? "Ollama URL" : "Base URL"}</span>
                    <input className="input" value={d.baseUrl} onChange={(e) => setDraft(p.name, { baseUrl: e.target.value })} />
                  </label>
                )}
                {p.requiresKey && (
                  <label className="block sm:col-span-2">
                    <span className="label">API key {p.hasKey && <span className="text-ink-faint">(leave blank to keep current)</span>}</span>
                    <input type="password" className="input" autoComplete="off" value={d.apiKey} placeholder={p.hasKey ? "•••••••• stored" : "paste key"} onChange={(e) => setDraft(p.name, { apiKey: e.target.value })} />
                  </label>
                )}
              </div>
              <div className="mt-2 flex gap-2">
                <button onClick={() => void saveConfig(p)} disabled={!!busy} className="btn-primary !py-1.5 text-xs">
                  {busy === `save:${p.name}` ? "Saving…" : "Save"}
                </button>
                {p.requiresKey && p.hasKey && p.keySource === "db" && (
                  <button onClick={() => void clearKey(p)} disabled={!!busy} className="btn-ghost !py-1.5 text-xs text-down">Clear key</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {message && <p className="mt-3 text-sm text-warn" role="status">{message}</p>}
    </section>
  );
}
