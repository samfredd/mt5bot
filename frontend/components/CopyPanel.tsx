"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconBrain, IconX } from "@/components/icons";

interface Trader {
  id: string; name: string; source: string; active: boolean; riskScore: number;
  metrics: Record<string, unknown>; _count?: { copiedTrades: number };
}

const SAMPLE_METRICS = {
  winRate: 58, profitFactor: 1.6, maxDrawdownPct: 12, avgMonthlyReturnPct: 4.5,
  consistency: 72, accountAgeMonths: 30, tradesPerWeek: 14, avgTradeDurationHours: 6,
  maxLossStreak: 4, recoveryBehavior: "good", symbolSpecialization: ["EURUSD", "GBPUSD"],
  lotBehavior: "consistent", newsBehavior: "avoids",
};

export function CopyPanel() {
  const [traders, setTraders] = useState<Trader[]>([]);
  const [evalResult, setEvalResult] = useState<{ name: string; explanation: string } | null>(null);
  const [form, setForm] = useState({ name: "", source: "manual", metrics: JSON.stringify(SAMPLE_METRICS, null, 2) });
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try { setTraders(await api<Trader[]>("/api/copy-traders")); } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    try {
      const metrics = JSON.parse(form.metrics);
      await api("/api/copy-traders", { method: "POST", body: { name: form.name, source: form.source, metrics, copyRules: { lotMultiplier: 1, stopAfterLossStreak: 5, maxSourceLot: 1 } } });
      setForm({ ...form, name: "" });
      await load();
    } catch (err) { setMessage(err instanceof Error ? err.message : "failed"); }
  }

  async function action(t: Trader, what: "activate" | "deactivate" | "evaluate") {
    setMessage("");
    try {
      const res = await api<{ explanation?: string }>(`/api/copy-traders/${t.id}/${what}`, { method: "POST" });
      if (what === "evaluate" && res.explanation) setEvalResult({ name: t.name, explanation: res.explanation });
      await load();
    } catch (err) { setMessage(err instanceof Error ? err.message : "failed"); }
  }

  return (
    <div className="space-y-6">
      <section className="card border-teal-900/50">
        <h2 className="section-title text-primary">Copy real human traders</h2>
        <ol className="list-inside list-decimal space-y-1.5 text-sm text-ink-dim">
          <li><b className="text-ink">Telegram signals</b> — forward any trader's signal message to your linked bot (or add the bot to a signal group). It reads messages like <span className="tnum font-mono text-xs">BUY EURUSD SL 1.0800 TP 1.0950</span>, creates a profile for that trader automatically, and — once you activate them below — copies their signals through your risk engine.</li>
          <li><b className="text-ink">Webhooks</b> — point TradingView alerts or any signal API at <span className="tnum font-mono text-xs">POST /api/copy-traders/&lt;id&gt;/signal</span>.</li>
          <li><b className="text-ink">MQL5 Signals</b> — for fully managed mirroring of an MQL5 provider, subscribe inside the MT5 terminal itself (Toolbox → Signals); the terminal then copies natively and this dashboard tracks the resulting positions.</li>
        </ol>
        <p className="mt-3 text-xs text-ink-faint">
          Every copied signal still passes your copy rules (symbol allow/block lists, loss-streak auto-stop, abnormal-lot
          rejection) and the full risk engine — no human trader can bypass your limits. Signals without a lot size are
          sized from your max-risk-per-trade setting.
        </p>
      </section>

      <section className="card">
        <h2 className="section-title">Copy traders</h2>
        <p className="mb-4 text-xs text-ink-dim">
          Copied trades pass through the same risk engine as your own. Traders scoring 70+ cannot be activated.
        </p>
        {traders.length === 0 && <p className="py-6 text-center text-sm text-ink-faint">No traders added yet.</p>}
        <div className="space-y-2">
          {traders.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm">
              <div className="flex items-center gap-2.5">
                <span className={`h-2 w-2 rounded-full ${t.active ? "bg-up" : "bg-ink-faint"}`} aria-hidden />
                <span className="font-medium">{t.name}</span>
                <RiskScore score={t.riskScore} />
                <span className="tnum text-xs text-ink-faint">{t._count?.copiedTrades ?? 0} copied</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => action(t, "evaluate")} className="btn-ghost btn-sm"><IconBrain size={12} /> AI evaluate</button>
                <button onClick={() => action(t, t.active ? "deactivate" : "activate")}
                  className={`btn btn-sm ${t.active ? "bg-red-950 text-red-300 ring-1 ring-red-900 hover:bg-red-900" : "bg-emerald-900 text-emerald-100 hover:bg-emerald-800"}`}>
                  {t.active ? "Stop copying" : "Copy"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="section-title">Add trader</h2>
        <form onSubmit={add} className="space-y-3">
          <div>
            <label htmlFor="trader-name" className="label">Trader name</label>
            <input id="trader-name" className="input" placeholder="e.g. Steady Eddie"
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <label htmlFor="trader-metrics" className="label">Performance metrics (JSON)</label>
            <textarea id="trader-metrics" className="input tnum h-44 resize-y font-mono !text-xs"
              value={form.metrics} onChange={(e) => setForm({ ...form, metrics: e.target.value })} />
          </div>
          <button className="btn-primary">Add & score</button>
        </form>
      </section>

      {message && <p className="text-sm text-warn" role="status">{message}</p>}

      {evalResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setEvalResult(null)}>
          <div className="card w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-base font-semibold">Evaluation: {evalResult.name}</h3>
              <button onClick={() => setEvalResult(null)} aria-label="Close" className="btn-ghost btn-sm"><IconX size={14} /></button>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim">{evalResult.explanation}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function RiskScore({ score }: { score: number }) {
  const tone = score < 45 ? "text-up" : score < 70 ? "text-warn" : "text-down";
  const barTone = score < 45 ? "bg-up" : score < 70 ? "bg-warn" : "bg-down";
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`Risk score ${score} of 100`}>
        <span className={`block h-full ${barTone}`} style={{ width: `${score}%` }} />
      </span>
      <span className={`tnum text-xs font-medium ${tone}`}>{score}</span>
    </span>
  );
}
