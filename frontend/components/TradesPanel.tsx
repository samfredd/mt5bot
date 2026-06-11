"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Overview } from "@/app/dashboard/page";
import { IconBrain, IconCheck, IconClock, IconDown, IconUp, IconX } from "@/components/icons";

interface Trade {
  id: string;
  symbol: string;
  direction: string;
  lots: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  status: string;
  mode: string;
  profit: number | null;
  createdAt: string;
  strategy?: { name: string } | null;
  explanation?: Record<string, unknown>;
}

export function TradesPanel({ openTrades, onChanged }: { openTrades: Overview["openTrades"]; onChanged: () => void }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState<Trade | null>(null);
  const [lotInputs, setLotInputs] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try { setTrades(await api<Trade[]>("/api/trades?limit=50")); } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(path: string, body?: unknown) {
    setMessage("");
    try {
      const res = await api<{ ok?: boolean; message?: string }>(path, { method: "POST", body });
      if (res.message) setMessage(res.message);
      await load(); onChanged();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Request failed"); }
  }

  const pending = trades.filter((t) => t.status === "PENDING_APPROVAL");

  return (
    <div className="space-y-6">
      {pending.length > 0 && (
        <section className="card border-warn/30 bg-amber-950/10">
          <h2 className="section-title text-warn">
            <IconClock size={15} /> Awaiting your approval
          </h2>
          <div className="space-y-3">
            {pending.map((t) => {
              const exp = (t.explanation ?? {}) as { scanner?: boolean; ai?: { confidence?: number; reasoning?: string } };
              const lotValue = lotInputs[t.id] ?? String(t.lots);
              return (
                <div key={t.id} className="rounded-xl border border-line bg-surface-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <DirectionBadge direction={t.direction} />
                    <span className="font-semibold">{t.symbol}</span>
                    {exp.scanner && (
                      <span className="chip bg-violet-950 text-violet"><IconBrain size={11} /> AI suggestion</span>
                    )}
                    {typeof exp.ai?.confidence === "number" && (
                      <span className="chip tnum bg-surface-3 text-ink-dim">confidence {(exp.ai.confidence * 100).toFixed(0)}%</span>
                    )}
                    {t.strategy && <span className="text-xs text-ink-faint">{t.strategy.name}</span>}
                  </div>
                  {exp.ai?.reasoning && (
                    <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-dim">{exp.ai.reasoning}</p>
                  )}
                  <div className="tnum mt-2 flex flex-wrap gap-4 text-xs text-ink-dim">
                    <span>Entry ~{t.entryPrice ?? "mkt"}</span>
                    <span>SL {t.stopLoss ?? "—"}</span>
                    <span>TP {t.takeProfit ?? "—"}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <div>
                      <label htmlFor={`lots-${t.id}`} className="label">Lot size (suggested {t.lots})</label>
                      <input id={`lots-${t.id}`} type="number" step="0.01" min="0.01" inputMode="decimal"
                        className="input tnum !w-28" value={lotValue}
                        onChange={(e) => setLotInputs({ ...lotInputs, [t.id]: e.target.value })} />
                    </div>
                    <button
                      onClick={() => {
                        const lots = Number(lotValue);
                        if (!(lots > 0)) { setMessage("Enter a valid lot size."); return; }
                        void act(`/api/trades/${t.id}/approve`, { lots });
                      }}
                      className="btn bg-emerald-800 text-white hover:bg-emerald-700">
                      <IconCheck size={15} /> Approve
                    </button>
                    <button onClick={() => act(`/api/trades/${t.id}/reject`)} className="btn-danger">
                      <IconX size={15} /> Reject
                    </button>
                    <button onClick={() => setDetail(t)} className="btn-ghost">Why this trade?</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="section-title">Open positions</h2>
        {openTrades.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-faint">No open positions. New trades appear here the moment they execute.</p>
        )}
        <div className="space-y-2">
          {openTrades.map((p) => (
            <div key={p.ticket} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm">
              <div className="flex items-center gap-2.5">
                <DirectionBadge direction={p.type.toUpperCase()} />
                <span className="font-medium">{p.symbol}</span>
                <span className="tnum text-xs text-ink-dim">{p.volume} lots @ {p.price_open}</span>
                <span className="tnum hidden text-xs text-ink-faint sm:inline">SL {p.sl ?? "—"} · TP {p.tp ?? "—"}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className={`tnum flex items-center gap-1 font-semibold ${p.profit >= 0 ? "text-up" : "text-down"}`}>
                  {p.profit >= 0 ? <IconUp size={13} /> : <IconDown size={13} />}
                  {p.profit >= 0 ? "+" : ""}{p.profit.toFixed(2)}
                </span>
                <button onClick={() => { if (confirm(`Close position ${p.ticket} (${p.symbol})?`)) void act(`/api/positions/${p.ticket}/close`); }}
                  className="btn-danger btn-sm">Close</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <ManualTrade onDone={() => { void load(); onChanged(); }} />

      <section className="card">
        <h2 className="section-title">Trade history & decisions</h2>
        {trades.length === 0 && <p className="py-6 text-center text-sm text-ink-faint">No trades yet.</p>}
        <div className="max-h-96 space-y-1 overflow-auto">
          {trades.map((t) => (
            <button key={t.id} onClick={() => setDetail(t)}
              className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-surface-2">
              <span className="flex items-center gap-2">
                <span className="tnum text-ink-faint">{new Date(t.createdAt).toLocaleString()}</span>
                <DirectionBadge direction={t.direction} small />
                <span className="font-medium text-ink">{t.symbol}</span>
                <span className="tnum text-ink-faint">{t.lots}</span>
              </span>
              <span className={`tnum font-medium ${statusColor(t.status)}`}>
                {statusLabel(t.status)}{t.profit != null ? ` · ${t.profit >= 0 ? "+" : ""}${t.profit.toFixed(2)}` : ""}
              </span>
            </button>
          ))}
        </div>
      </section>

      {message && <p className="text-sm text-warn" role="status">{message}</p>}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setDetail(null)}>
          <div className="card max-h-[80vh] w-full max-w-2xl overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <DirectionBadge direction={detail.direction} /> {detail.symbol} — decision trail
              </h3>
              <button onClick={() => setDetail(null)} aria-label="Close" className="btn-ghost btn-sm"><IconX size={14} /></button>
            </div>
            <DecisionTrail explanation={detail.explanation ?? {}} />
          </div>
        </div>
      )}
    </div>
  );
}

function DirectionBadge({ direction, small }: { direction: string; small?: boolean }) {
  const isBuy = direction === "BUY" || direction === "buy";
  return (
    <span className={`chip ${small ? "!px-1.5 !py-0.5 !text-[10px]" : ""} ${isBuy ? "bg-emerald-950 text-up" : "bg-red-950 text-down"}`}>
      {isBuy ? <IconUp size={small ? 10 : 12} /> : <IconDown size={small ? 10 : 12} />}
      {isBuy ? "BUY" : "SELL"}
    </span>
  );
}

function statusLabel(s: string) {
  return ({
    EXECUTED: "Executed", CLOSED: "Closed", RISK_BLOCKED: "Risk blocked", FAILED: "Failed",
    REJECTED: "Rejected", PENDING_APPROVAL: "Pending", CANCELLED: "Cancelled", ANALYZED: "Analyzed", APPROVED: "Approved",
  } as Record<string, string>)[s] ?? s;
}

function statusColor(s: string) {
  if (s === "EXECUTED" || s === "CLOSED") return "text-up";
  if (s === "RISK_BLOCKED" || s === "FAILED" || s === "REJECTED") return "text-down";
  if (s === "PENDING_APPROVAL") return "text-warn";
  return "text-ink-faint";
}

/** Render the explanation JSON as readable sections instead of a raw dump. */
function DecisionTrail({ explanation }: { explanation: Record<string, unknown> }) {
  const e = explanation as {
    strategy?: { name?: string; reasons?: string[] };
    ai?: { decision?: string; confidence?: number; reasoning?: string; risk_level?: string };
    news?: { level?: string; action?: string; reason?: string };
    risk?: { ok?: boolean; checks?: { name: string; passed: boolean; detail: string }[] };
    execution?: { ok?: boolean; ticket?: string; error?: string };
    approval?: { decidedBy?: string; channel?: string; chosenLots?: number };
  };
  return (
    <div className="space-y-4 text-sm">
      {e.strategy && (
        <Section title="Strategy signal">
          <p className="font-medium text-ink">{e.strategy.name}</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-ink-dim">
            {(e.strategy.reasons ?? []).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </Section>
      )}
      {e.ai && (
        <Section title="AI reasoning">
          <p className="text-xs text-ink-dim">
            <span className="font-medium text-ink">{e.ai.decision?.toUpperCase()}</span>
            {typeof e.ai.confidence === "number" && <span className="tnum"> · confidence {(e.ai.confidence * 100).toFixed(0)}%</span>}
            {e.ai.risk_level && <span> · risk {e.ai.risk_level}</span>}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-dim">{e.ai.reasoning}</p>
        </Section>
      )}
      {e.news && (
        <Section title="News gate">
          <p className="text-xs text-ink-dim"><span className="font-medium uppercase text-ink">{e.news.level}</span> → {e.news.action}. {e.news.reason}</p>
        </Section>
      )}
      {e.risk?.checks && (
        <Section title={`Risk checks ${e.risk.ok ? "— all passed" : "— BLOCKED"}`}>
          <div className="grid gap-1 sm:grid-cols-2">
            {e.risk.checks.map((c) => (
              <div key={c.name} className={`flex items-start gap-1.5 text-xs ${c.passed ? "text-ink-dim" : "text-down"}`}>
                {c.passed ? <IconCheck size={12} className="mt-0.5 shrink-0 text-up" /> : <IconX size={12} className="mt-0.5 shrink-0" />}
                <span><span className="font-medium">{c.name.replace(/_/g, " ")}</span>: {c.detail}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
      {e.approval && (
        <Section title="Approval">
          <p className="text-xs text-ink-dim">By {e.approval.decidedBy} via {e.approval.channel}{e.approval.chosenLots ? `, chose ${e.approval.chosenLots} lots` : ""}.</p>
        </Section>
      )}
      {e.execution && (
        <Section title="Execution">
          <p className={`text-xs ${e.execution.ok ? "text-up" : "text-down"}`}>
            {e.execution.ok ? `Executed — ticket ${e.execution.ticket}` : `Failed — ${e.execution.error}`}
          </p>
        </Section>
      )}
      {!e.strategy && !e.ai && !e.risk && (
        <pre className="overflow-auto rounded-lg bg-bg p-3 text-xs text-ink-dim">{JSON.stringify(explanation, null, 2)}</pre>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h4>
      {children}
    </div>
  );
}

function ManualTrade({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ symbol: "EURUSD", direction: "buy", lots: "0.01", stopLoss: "", takeProfit: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    setBusy(true);
    try {
      await api("/api/trades/manual", {
        method: "POST",
        body: {
          symbol: form.symbol, direction: form.direction, lots: Number(form.lots),
          stopLoss: form.stopLoss ? Number(form.stopLoss) : null,
          takeProfit: form.takeProfit ? Number(form.takeProfit) : null,
        },
      });
      setMessage("Trade submitted — passed all risk checks.");
      onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="section-title">Manual trade <span className="font-normal text-ink-faint">(still risk-gated)</span></h2>
      <form onSubmit={submit} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <label htmlFor="mt-symbol" className="label">Symbol</label>
          <input id="mt-symbol" className="input" value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} required />
        </div>
        <div>
          <label htmlFor="mt-dir" className="label">Direction</label>
          <select id="mt-dir" className="input cursor-pointer" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
            <option value="buy">Buy</option><option value="sell">Sell</option>
          </select>
        </div>
        <div>
          <label htmlFor="mt-lots" className="label">Lots</label>
          <input id="mt-lots" className="input tnum" type="number" step="0.01" min="0.01" inputMode="decimal" value={form.lots}
            onChange={(e) => setForm({ ...form, lots: e.target.value })} required />
        </div>
        <div>
          <label htmlFor="mt-sl" className="label">Stop loss</label>
          <input id="mt-sl" className="input tnum" inputMode="decimal" value={form.stopLoss}
            onChange={(e) => setForm({ ...form, stopLoss: e.target.value })} placeholder="required" />
        </div>
        <div>
          <label htmlFor="mt-tp" className="label">Take profit</label>
          <input id="mt-tp" className="input tnum" inputMode="decimal" value={form.takeProfit}
            onChange={(e) => setForm({ ...form, takeProfit: e.target.value })} placeholder="optional" />
        </div>
        <button disabled={busy} className="btn-primary">{busy ? "Submitting…" : "Submit trade"}</button>
      </form>
      {message && <p className="mt-3 text-sm text-warn" role="status">{message}</p>}
    </section>
  );
}
