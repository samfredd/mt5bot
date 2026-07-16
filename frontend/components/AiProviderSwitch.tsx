"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ToastProvider";

interface ProviderInfo {
  name: string;
  model: string;
  baseUrl: string;
  requiresKey: boolean;
  hasKey: boolean;
  configured: boolean;
  keySource: "db" | "none";
}
interface ProviderState { active: string; providers: ProviderInfo[] }
interface ProviderModels { provider: string; models: string[] }

const LABELS: Record<string, string> = {
  pure_logic: "Pure logic (no AI model)",
  ollama: "Ollama (local)",
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  nvidia: "NVIDIA NIM",
};
const SHOWS_BASE_URL = new Set(["ollama", "openai", "openrouter", "nvidia"]);
const MODEL_HINT: Record<string, string> = {
  ollama: "e.g. gemma4:12b",
  anthropic: "e.g. claude-3-5-sonnet-latest",
  openai: "e.g. gpt-4o-mini",
  openrouter: "e.g. anthropic/claude-3.5-sonnet",
  nvidia: "e.g. nvidia/nemotron-3-super-120b-a12b",
};

type Draft = { model: string; baseUrl: string; apiKey: string };

export function AiProviderSwitch() {
  const toast = useToast();
  const [state, setState] = useState<ProviderState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState("");
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, string[]>>({});
  const [modelBusy, setModelBusy] = useState("");
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});

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

  async function loadModels(provider: string) {
    setModelBusy(provider);
    setModelErrors((errors) => ({ ...errors, [provider]: "" }));
    try {
      const result = await api<ProviderModels>(`/api/ai/provider-models/${encodeURIComponent(provider)}`);
      setModelCatalogs((catalogs) => ({ ...catalogs, [provider]: result.models }));
    } catch (err) {
      setModelErrors((errors) => ({
        ...errors,
        [provider]: err instanceof Error ? err.message : "could not load models",
      }));
    } finally {
      setModelBusy("");
    }
  }

  async function switchTo(provider: string) {
    if (provider === state!.active) return;
    setBusy(`switch:${provider}`);
    try { apply(await api<ProviderState>("/api/ai/provider", { method: "PUT", body: { provider } })); toast.success("AI provider changed", `Now using ${LABELS[provider] ?? provider}.`); }
    catch (err) { toast.error("Provider change failed", err instanceof Error ? err.message : "The provider could not be changed."); }
    finally { setBusy(""); }
  }

  async function saveConfig(p: ProviderInfo) {
    const d = drafts[p.name];
    setBusy(`save:${p.name}`);
    try {
      const body: Record<string, unknown> = { provider: p.name, model: d.model };
      if (SHOWS_BASE_URL.has(p.name)) body.baseUrl = d.baseUrl;
      if (d.apiKey.trim()) body.apiKey = d.apiKey.trim();
      const next = await api<ProviderState>("/api/ai/provider-config", { method: "PUT", body });
      apply(next);
      toast.success("Provider settings saved", `${LABELS[p.name] ?? p.name} is ready to use.`);
      if (next.providers.find((provider) => provider.name === p.name)?.configured) void loadModels(p.name);
    } catch (err) { toast.error("Provider settings not saved", err instanceof Error ? err.message : "The provider configuration was rejected."); }
    finally { setBusy(""); }
  }

  async function clearKey(p: ProviderInfo) {
    setBusy(`clear:${p.name}`);
    try { apply(await api<ProviderState>("/api/ai/provider-config", { method: "PUT", body: { provider: p.name, clearKey: true } })); toast.success("API key removed", `${LABELS[p.name] ?? p.name} key was cleared.`); }
    catch (err) { toast.error("API key not removed", err instanceof Error ? err.message : "The key could not be cleared."); }
    finally { setBusy(""); }
  }

  return (
    <section className="card">
      <h2 className="section-title">AI provider</h2>
      <p className="mb-4 text-xs text-ink-dim">
        Choose the operating mode below. Pure logic uses technical strategy signals and the risk engine only; a model provider adds AI vetting.
        Provider settings are saved encrypted in the database, with no <code>.env</code> editing needed.
      </p>

      <label className="mb-4 block max-w-md">
        <span className="label">Active AI mode</span>
        <select
          className="input"
          value={state.active}
          disabled={!!busy}
          onChange={(e) => void switchTo(e.target.value)}
        >
          <option value="pure_logic">Pure logic — no AI model</option>
          {state.providers.map((p) => (
            <option key={p.name} value={p.name} disabled={!p.configured}>
              {LABELS[p.name] ?? p.name}{p.configured ? "" : " (configure first)"}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-ink-faint">Changing this takes effect immediately for new trade evaluations.</span>
      </label>

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
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="label">Model (select or type manually)</span>
                  <input
                    className="input"
                    list={`${p.name}-model-catalog`}
                    value={d.model}
                    placeholder={MODEL_HINT[p.name]}
                    onFocus={() => {
                      if (p.configured && modelCatalogs[p.name] === undefined && modelBusy !== p.name) void loadModels(p.name);
                    }}
                    onChange={(e) => setDraft(p.name, { model: e.target.value })}
                  />
                  <datalist id={`${p.name}-model-catalog`}>
                    {(modelCatalogs[p.name] ?? []).map((model) => <option key={model} value={model} />)}
                  </datalist>
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
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-ghost !py-1.5 text-xs"
                  disabled={!!modelBusy || (p.requiresKey && !p.hasKey)}
                  onClick={() => void loadModels(p.name)}
                >
                  {modelBusy === p.name ? "Loading models…" : modelCatalogs[p.name] ? "Refresh model list" : "Load model list"}
                </button>
                {modelCatalogs[p.name] && (
                  <span className="text-xs text-ink-faint">{modelCatalogs[p.name].length} models available; manual IDs are still accepted.</span>
                )}
                {p.requiresKey && !p.hasKey && <span className="text-xs text-ink-faint">Save an API key to load models.</span>}
              </div>
              {modelErrors[p.name] && <p className="mt-1 text-xs text-down" role="alert">{modelErrors[p.name]}</p>}
              {p.name === "nvidia" && (
                <p className="mt-2 text-xs text-ink-faint">
                  Recommended for trade vetting: Nemotron 3 Super. You can also use <code>z-ai/glm-5.2</code> with the same NVIDIA key.
                </p>
              )}
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
    </section>
  );
}
