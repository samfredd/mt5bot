"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ToastReporter } from "@/components/ToastProvider";
import { IconMessageCircle } from "@/components/icons";

type Provider = "ollama" | "anthropic" | "openai" | "openrouter" | "nvidia";
interface Config { enabled: boolean; providerMode: "system" | "separate"; provider?: Provider; model: string; telegramEnabled: boolean; whatsappEnabled: boolean; }
interface ProviderSummary { name: Provider; configured: boolean; model: string; }

export function AssistantSettings({ onMsg }: { onMsg: ToastReporter }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const load = useCallback(async () => {
    try {
      const [saved, ai] = await Promise.all([api<Config>("/api/assistant/settings"), api<{ providers: ProviderSummary[] }>("/api/ai/provider")]);
      setConfig(saved); setProviders(ai.providers);
    } catch { /* permissions or backend startup */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!config?.provider || config.providerMode !== "separate") { setModels([]); return; }
    setLoadingModels(true);
    api<{ models: string[] }>(`/api/ai/provider-models/${config.provider}`).then((result) => setModels(result.models)).catch(() => setModels([])).finally(() => setLoadingModels(false));
  }, [config?.provider, config?.providerMode]);
  if (!config) return null;
  const set = (patch: Partial<Config>) => setConfig({ ...config, ...patch });
  async function save() {
    try { setConfig(await api<Config>("/api/assistant/settings", { method: "PUT", body: config })); onMsg("Assistant settings saved. Telegram and WhatsApp changes take effect immediately."); }
    catch (error) { onMsg(error instanceof Error ? error.message : "Could not save assistant settings.", "error"); }
  }
  return <section className="card">
    <h2 className="section-title"><IconMessageCircle size={16} className="text-primary" /> System assistant</h2>
    <p className="mb-4 text-xs leading-relaxed text-ink-dim">The assistant answers from current system data and can prepare configuration changes. Mutations always require a one-time confirmation. It never bypasses live-trading gates, risk controls, or 2FA.</p>
    <div className="grid gap-3 md:grid-cols-2">
      <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-surface-2 p-3"><input type="checkbox" className="mt-1 accent-teal-500" checked={config.enabled} onChange={(event) => set({ enabled: event.target.checked })} /><span className="text-sm"><span className="font-medium">Assistant enabled</span><span className="block text-xs text-ink-faint">Available in the dashboard and selected messaging channels.</span></span></label>
      <div><label htmlFor="assistant-provider-mode" className="label">Model source</label><select id="assistant-provider-mode" className="input" value={config.providerMode} onChange={(event) => set({ providerMode: event.target.value as Config["providerMode"] })}><option value="system">Use the system AI provider and model</option><option value="separate">Use a separate provider/model</option></select></div>
      {config.providerMode === "separate" && <>
        <div><label htmlFor="assistant-provider" className="label">Assistant provider</label><select id="assistant-provider" className="input" value={config.provider ?? ""} onChange={(event) => set({ provider: event.target.value as Provider, model: "" })}><option value="">Select provider</option>{providers.map((provider) => <option key={provider.name} value={provider.name} disabled={!provider.configured}>{provider.name}{provider.configured ? "" : " (configure first)"}</option>)}</select></div>
        <div><label htmlFor="assistant-model-select" className="label">Provider model</label><select id="assistant-model-select" className="input" value={models.includes(config.model) ? config.model : ""} onChange={(event) => set({ model: event.target.value })} disabled={!config.provider || loadingModels}><option value="">{loadingModels ? "Loading models…" : "Select a fetched model"}</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select><input aria-label="Manual assistant model" className="input mt-2" placeholder="Or enter a model ID manually" value={config.model} onChange={(event) => set({ model: event.target.value })} /></div>
      </>}
    </div>
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <label className="flex cursor-pointer items-center gap-3 rounded-xl bg-surface-2 p-3 text-sm"><input type="checkbox" className="accent-teal-500" checked={config.telegramEnabled} onChange={(event) => set({ telegramEnabled: event.target.checked })} />Telegram assistant (/ask or normal message)</label>
      <label className="flex cursor-pointer items-center gap-3 rounded-xl bg-surface-2 p-3 text-sm"><input type="checkbox" className="accent-teal-500" checked={config.whatsappEnabled} onChange={(event) => set({ whatsappEnabled: event.target.checked })} />WhatsApp assistant (normal message)</label>
    </div>
    <button type="button" onClick={() => void save()} className="btn-primary mt-4">Save assistant settings</button>
  </section>;
}
