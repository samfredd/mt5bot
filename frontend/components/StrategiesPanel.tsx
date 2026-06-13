"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconPlus, IconTrash, IconX } from "@/components/icons";

interface Strategy { id: string; name: string; type: string; enabled: boolean; config: Record<string, unknown> }
interface Preset { name: string; type: string; config: Record<string, unknown> }

const EXAMPLE_CONFIG = {
  symbols: ["EURUSD", "GBPUSD"],
  timeframes: ["H1", "H4"],
  entry: {
    requireTrendAlignment: true,
    rsiOversold: 30,
    rsiOverbought: 70,
    useMacdCross: true,
    useCandlePatterns: true,
    minConfidence: 0.65,
  },
  exit: {
    stopLossAtrMult: 1.5,
    takeProfitAtrMult: 3.0,
    trailingStop: true,
  },
  lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 1.0 },
  maxTradesPerDay: 3,
  sessions: ["london", "newyork", "london_newyork_overlap"],
  newsBehavior: "pause",
};

const FIELD_GUIDE: { key: string; desc: string }[] = [
  { key: "symbols", desc: "Instruments to trade — must exist at your broker (check the terminal's Market Watch)." },
  { key: "timeframes", desc: "First = entry timeframe, last = higher-TF trend confirmation. M1 M5 M15 M30 H1 H4 D1." },
  { key: "entry.requireTrendAlignment", desc: "Higher timeframe must agree with the signal (raises the confluence bar from 2 to 3)." },
  { key: "entry.rsiOversold / rsiOverbought", desc: "RSI levels that count as a buy/sell confluence." },
  { key: "entry.useMacdCross / useCandlePatterns", desc: "Extra confluence sources (MACD histogram sign; hammer, engulfing, shooting star)." },
  { key: "entry.minConfidence", desc: "Minimum AI confidence (0–1) before a signal can proceed. 0.65+ recommended." },
  { key: "exit.stopLossAtrMult / takeProfitAtrMult", desc: "SL/TP distance as ATR multiples. Keep TP ≥ 2× SL for a healthy risk:reward." },
  { key: "exit.trailingStop", desc: "Trail the stop one ATR behind price once the trade is +1.5R in profit." },
  { key: "lotSizing", desc: "\"risk_pct\" sizes each trade from riskPct% of balance and the stop distance; \"fixed\" always uses fixedLots." },
  { key: "maxTradesPerDay", desc: "Hard cap on entries per day for this strategy." },
  { key: "sessions", desc: "When it may trade: asia, london, london_newyork_overlap, newyork, sydney." },
  { key: "newsBehavior", desc: "\"pause\" (skip during news), \"reduce\" (half size), or \"ignore\"." },
];

const TYPES = ["trend_following", "scalping", "swing", "price_action", "news_aware", "custom"];

export function StrategiesPanel() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [configText, setConfigText] = useState("");
  const [message, setMessage] = useState("");
  const [showBuilder, setShowBuilder] = useState(false);
  const [builder, setBuilder] = useState({
    name: "", type: "custom", config: JSON.stringify(EXAMPLE_CONFIG, null, 2),
  });
  const [busy, setBusy] = useState(false);

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

  async function createCustom(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    setBusy(true);
    try {
      let config: unknown;
      try {
        config = JSON.parse(builder.config);
      } catch {
        setMessage("Config is not valid JSON — check for missing commas or quotes.");
        return;
      }
      await api("/api/strategies", { method: "POST", body: { name: builder.name, type: builder.type, config } });
      setMessage(`Strategy "${builder.name}" created (disabled — enable it when ready, backtest it first).`);
      setBuilder({ name: "", type: "custom", config: JSON.stringify(EXAMPLE_CONFIG, null, 2) });
      setShowBuilder(false);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: Strategy) {
    try { await api(`/api/strategies/${s.id}`, { method: "PUT", body: { enabled: !s.enabled } }); await load(); }
    catch (err) { setMessage(err instanceof Error ? err.message : "failed"); }
  }

  async function remove(s: Strategy) {
    if (!confirm(
      `Delete "${s.name}"?\n\n${s.enabled ? "It is currently ENABLED and will stop trading immediately. " : ""}Past trades keep their history but will no longer reference this strategy. This cannot be undone.`,
    )) return;
    setMessage("");
    try {
      await api(`/api/strategies/${s.id}`, { method: "DELETE" });
      setMessage(`Deleted "${s.name}".`);
      await load();
    } catch (err) { setMessage(err instanceof Error ? err.message : "delete failed (admin only)"); }
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
          <p className="py-6 text-center text-sm text-ink-faint">No strategies yet — add a preset or build your own below.</p>
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
                <button onClick={() => remove(s)} aria-label={`Delete ${s.name}`} className="btn-danger btn-sm">
                  <IconTrash size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-title !mb-0">Build your own strategy</h2>
          <button onClick={() => setShowBuilder(!showBuilder)} className="btn-primary btn-sm">
            <IconPlus size={13} /> {showBuilder ? "Hide builder" : "New custom strategy"}
          </button>
        </div>
        {showBuilder && (
          <form onSubmit={createCustom} className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <div>
                <label htmlFor="cs-name" className="label">Strategy name</label>
                <input id="cs-name" className="input" placeholder="e.g. Gold London Breakout" value={builder.name}
                  onChange={(e) => setBuilder({ ...builder, name: e.target.value })} required />
              </div>
              <div>
                <label htmlFor="cs-type" className="label">Type</label>
                <select id="cs-type" className="input cursor-pointer" value={builder.type}
                  onChange={(e) => setBuilder({ ...builder, type: e.target.value })}>
                  {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="cs-config" className="label">Configuration (JSON)</label>
                  <button type="button" className="cursor-pointer text-xs text-accent hover:underline"
                    onClick={() => setBuilder({ ...builder, config: JSON.stringify(EXAMPLE_CONFIG, null, 2) })}>
                    Reset to example
                  </button>
                </div>
                <textarea id="cs-config" className="input tnum h-96 resize-y font-mono !text-xs" spellCheck={false}
                  value={builder.config} onChange={(e) => setBuilder({ ...builder, config: e.target.value })} />
              </div>
              <button disabled={busy} className="btn-primary">
                {busy ? "Creating…" : "Create strategy"}
              </button>
              <p className="text-xs text-ink-faint">
                New strategies start <b>disabled</b>. Backtest them first (Backtest tab), then enable.
              </p>
            </div>
            <aside className="rounded-xl bg-surface-2 p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Field guide</h3>
              <dl className="space-y-2.5">
                {FIELD_GUIDE.map((f) => (
                  <div key={f.key}>
                    <dt className="tnum font-mono text-xs text-primary">{f.key}</dt>
                    <dd className="mt-0.5 text-xs leading-relaxed text-ink-dim">{f.desc}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          </form>
        )}
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
            <p className="mb-3 text-xs text-ink-dim">Same fields as the builder's guide — validated server-side on save.</p>
            <textarea aria-label="Strategy configuration JSON" className="input tnum h-80 resize-y font-mono !text-xs" spellCheck={false}
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
