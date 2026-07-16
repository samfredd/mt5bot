"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ToastProvider";
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
  openedAt?: string | null;
  closedAt?: string | null;
  closeAfterMin?: number | null;
  strategy?: { name: string } | null;
  explanation?: Record<string, unknown>;
}

function fmtDuration(ms: number): string {
  if (ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function modeBadge(t: Trade): { label: string; cls: string } {
  if ((t.explanation as { scanner?: boolean } | undefined)?.scanner) return { label: "AI scan", cls: "bg-violet-950 text-violet" };
  if (t.mode === "COPY") return { label: "Copy", cls: "bg-teal-950 text-primary" };
  if (t.mode === "AUTO") return { label: "Auto", cls: "bg-sky-950 text-accent" };
  if (t.mode === "SEMI_AUTO") return { label: "Semi", cls: "bg-amber-950 text-warn" };
  return { label: "Manual", cls: "bg-surface-3 text-ink-dim" };
}

export function TradesPanel({ openTrades, onChanged }: { openTrades: Overview["openTrades"]; onChanged: () => void }) {
  const toast = useToast();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [detail, setDetail] = useState<Trade | null>(null);
  const [lotInputs, setLotInputs] = useState<Record<string, string>>({});
  const [durations, setDurations] = useState<Record<string, string>>({});
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  // History is per trading account: "current" (default) shows only the
  // account the terminal is connected to; "all" shows every account.
  const [accountScope, setAccountScope] = useState<"current" | "all">("current");

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "100", account: accountScope });
      if (range.from) params.set("from", new Date(range.from).toISOString());
      if (range.to) params.set("to", new Date(`${range.to}T23:59:59`).toISOString());
      setTrades(await api<Trade[]>(`/api/trades?${params}`));
    } catch { /* noop */ }
  }, [range, accountScope]);
  useEffect(() => { void load(); }, [load]);

  function preset(daysBack: number) {
    const to = new Date();
    const from = new Date(Date.now() - daysBack * 86400_000);
    setRange({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
  }

  async function act(path: string, body?: unknown) {
    try {
      const res = await api<{ ok?: boolean; message?: string }>(path, { method: "POST", body });
      toast.success("Trade request completed", res.message ?? "The request passed the server checks and was applied.");
      await load(); onChanged();
    } catch (err) { toast.error("Trade request failed", err instanceof Error ? err.message : "The request could not be completed."); }
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
                    <div>
                      <label htmlFor={`dur-${t.id}`} className="label">Max duration</label>
                      <select id={`dur-${t.id}`} className="input cursor-pointer !w-32"
                        value={durations[t.id] ?? ""} onChange={(e) => setDurations({ ...durations, [t.id]: e.target.value })}>
                        <option value="">No limit</option>
                        <option value="60">1 hour</option>
                        <option value="240">4 hours</option>
                        <option value="480">8 hours</option>
                        <option value="1440">1 day</option>
                        <option value="4320">3 days</option>
                      </select>
                    </div>
                    <button
                      onClick={() => {
                        const lots = Number(lotValue);
                        if (!(lots > 0)) { toast.error("Invalid lot size", "Enter a valid lot size before approving the trade."); return; }
                        const durationMin = durations[t.id] ? Number(durations[t.id]) : undefined;
                        void act(`/api/trades/${t.id}/approve`, { lots, durationMin });
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
        {openTrades.length > 0 && <ExposureStrip positions={openTrades} />}
        {openTrades.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-faint">No open positions. New trades appear here the moment they execute.</p>
        )}
        {openTrades.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-ink-faint">
                <tr>
                  <th className="py-2 pr-3 font-medium">Opened</th>
                  <th className="pr-3 font-medium">Held</th>
                  <th className="pr-3 font-medium">Symbol</th>
                  <th className="pr-3 font-medium">Dir</th>
                  <th className="pr-3 font-medium">Lots</th>
                  <th className="pr-3 font-medium">Entry</th>
                  <th className="pr-3 font-medium">Now</th>
                  <th className="pr-3 font-medium">SL</th>
                  <th className="pr-3 font-medium">TP</th>
                  <th className="pr-3 font-medium" title="Profit measured in multiples of the initial risk (entry to stop distance)">R</th>
                  <th className="pr-3 font-medium">P/L</th>
                  <th className="pr-1" />
                </tr>
              </thead>
              <tbody className="tnum">
                {openTrades.map((p) => {
                  const isBuy = p.type === "buy";
                  const risk = p.sl != null ? Math.abs(p.price_open - p.sl) : null;
                  const move = p.price_current != null ? (isBuy ? p.price_current - p.price_open : p.price_open - p.price_current) : null;
                  const rMult = risk && risk > 0 && move != null ? move / risk : null;
                  return (
                    <tr key={p.ticket} className="border-t border-line">
                      <td className="py-2.5 pr-3 text-ink-faint">
                        {p.time ? new Date(p.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                      </td>
                      <td className="pr-3 text-ink-dim">{p.time ? fmtDuration(Date.now() - new Date(p.time).getTime()) : "—"}</td>
                      <td className="pr-3 font-sans font-medium text-ink">{p.symbol}</td>
                      <td className="pr-3"><DirectionBadge direction={p.type.toUpperCase()} small /></td>
                      <td className="pr-3">{p.volume}</td>
                      <td className="pr-3 text-ink-dim">{p.price_open}</td>
                      <td className="pr-3 text-ink">{p.price_current ?? "—"}</td>
                      <td className="pr-3 text-ink-dim">{p.sl ?? <span className="text-down">none</span>}</td>
                      <td className="pr-3 text-ink-dim">{p.tp ?? "—"}</td>
                      <td className={`pr-3 font-medium ${rMult == null ? "text-ink-faint" : rMult >= 0 ? "text-up" : "text-down"}`}>
                        {rMult != null ? `${rMult >= 0 ? "+" : ""}${rMult.toFixed(2)}R` : "—"}
                      </td>
                      <td className={`pr-3 font-semibold ${p.profit >= 0 ? "text-up" : "text-down"}`}>
                        {p.profit >= 0 ? "+" : ""}{p.profit.toFixed(2)}
                      </td>
                      <td className="pr-1">
                        <button onClick={() => { if (confirm(`Close position ${p.ticket} (${p.symbol})?`)) void act(`/api/positions/${p.ticket}/close`); }}
                          className="btn-danger btn-sm">Close</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ManualTrade onDone={() => { void load(); onChanged(); }} />

      <section className="card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-title !mb-0">Trade history & decisions</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <label htmlFor="hist-account" className="sr-only">Account scope</label>
            <select id="hist-account" className="input !w-36 !py-1.5 !text-xs cursor-pointer" value={accountScope}
              onChange={(e) => setAccountScope(e.target.value as "current" | "all")}>
              <option value="current">This account</option>
              <option value="all">All accounts</option>
            </select>
            <button onClick={() => preset(1)} className="btn-ghost btn-sm">Today</button>
            <button onClick={() => preset(7)} className="btn-ghost btn-sm">7d</button>
            <button onClick={() => preset(30)} className="btn-ghost btn-sm">30d</button>
            <label htmlFor="hist-from" className="sr-only">From date</label>
            <input id="hist-from" type="date" className="input !w-36 !py-1.5 !text-xs" value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <span className="text-xs text-ink-faint">→</span>
            <label htmlFor="hist-to" className="sr-only">To date</label>
            <input id="hist-to" type="date" className="input !w-36 !py-1.5 !text-xs" value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })} />
            {(range.from || range.to) && (
              <button onClick={() => setRange({ from: "", to: "" })} className="btn-ghost btn-sm">Clear</button>
            )}
          </div>
        </div>
        {trades.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-faint">
            {range.from || range.to
              ? "No trades in this period."
              : accountScope === "current" ? "No trades on this account yet." : "No trades yet."}
          </p>
        )}
        {(range.from || range.to) && trades.length > 0 && (
          <p className="mb-2 text-xs text-ink-faint">{trades.length} trade(s) in the selected period.</p>
        )}
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface text-ink-faint">
              <tr>
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="pr-3 font-medium">Symbol</th>
                <th className="pr-3 font-medium">Dir</th>
                <th className="pr-3 font-medium">Lots</th>
                <th className="pr-3 font-medium">Origin</th>
                <th className="pr-3 font-medium">Entry</th>
                <th className="pr-3 font-medium">SL / TP</th>
                <th className="pr-3 font-medium">Held</th>
                <th className="pr-3 font-medium">Status</th>
                <th className="pr-3 text-right font-medium">P/L</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {trades.map((t) => {
                const badge = modeBadge(t);
                const held = t.openedAt && t.closedAt
                  ? fmtDuration(new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime())
                  : t.openedAt && t.status === "EXECUTED"
                    ? fmtDuration(Date.now() - new Date(t.openedAt).getTime())
                    : "—";
                return (
                  <tr key={t.id} onClick={() => setDetail(t)}
                    className="cursor-pointer border-t border-line transition-colors hover:bg-surface-2"
                    title="Click for the full decision trail">
                    <td className="py-2.5 pr-3 text-ink-faint">
                      {new Date(t.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="pr-3 font-sans font-medium text-ink">{t.symbol}</td>
                    <td className="pr-3"><DirectionBadge direction={t.direction} small /></td>
                    <td className="pr-3">{t.lots}</td>
                    <td className="pr-3">
                      <span className={`chip !px-1.5 !py-0.5 !text-[10px] ${badge.cls}`}>{badge.label}</span>
                      {t.strategy && <span className="ml-1.5 font-sans text-[10px] text-ink-faint">{t.strategy.name}</span>}
                    </td>
                    <td className="pr-3 text-ink-dim">{t.entryPrice ?? "—"}</td>
                    <td className="pr-3 text-ink-faint">{t.stopLoss ?? "—"} / {t.takeProfit ?? "—"}</td>
                    <td className="pr-3 text-ink-dim">{held}</td>
                    <td className={`pr-3 font-sans font-medium ${statusColor(t.status)}`}>{statusLabel(t.status)}</td>
                    <td className={`pr-3 text-right font-semibold ${t.profit == null ? "text-ink-faint" : t.profit >= 0 ? "text-up" : "text-down"}`}>
                      {t.profit != null ? `${t.profit >= 0 ? "+" : ""}${t.profit.toFixed(2)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

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

function ExposureStrip({ positions }: { positions: Overview["openTrades"] }) {
  const longLots = positions.filter((p) => p.type === "buy").reduce((a, p) => a + p.volume, 0);
  const shortLots = positions.filter((p) => p.type === "sell").reduce((a, p) => a + p.volume, 0);
  const floating = positions.reduce((a, p) => a + p.profit, 0);
  const protectedCount = positions.filter((p) => p.sl != null).length;
  const items: { label: string; value: string; tone?: "up" | "down" | "warn" }[] = [
    { label: "Positions", value: String(positions.length) },
    { label: "Long / Short", value: `${longLots.toFixed(2)} / ${shortLots.toFixed(2)} lots` },
    {
      label: "Floating P/L", value: `${floating >= 0 ? "+" : ""}${floating.toFixed(2)}`,
      tone: floating >= 0 ? "up" : "down",
    },
    {
      label: "Stop-protected", value: `${protectedCount}/${positions.length}`,
      tone: protectedCount < positions.length ? "warn" : undefined,
    },
  ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className="rounded-xl bg-surface-2 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-faint">{i.label}</div>
          <div className={`tnum text-sm font-semibold ${i.tone === "up" ? "text-up" : i.tone === "down" ? "text-down" : i.tone === "warn" ? "text-warn" : "text-ink"}`}>
            {i.value}
          </div>
        </div>
      ))}
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
  const toast = useToast();
  const [form, setForm] = useState({ symbol: "EURUSD", direction: "buy", lots: "0.01", stopLoss: "", takeProfit: "", durationMin: "" });
  const [symbols, setSymbols] = useState<string[]>(["EURUSD"]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ symbols: string[] }>("/api/symbols");
        if (r.symbols.length) setSymbols(r.symbols);
      } catch { /* keep fallback */ }
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/trades/manual", {
        method: "POST",
        body: {
          symbol: form.symbol, direction: form.direction, lots: Number(form.lots),
          stopLoss: form.stopLoss ? Number(form.stopLoss) : null,
          takeProfit: form.takeProfit ? Number(form.takeProfit) : null,
          durationMin: form.durationMin ? Number(form.durationMin) : undefined,
        },
      });
      toast.success("Trade submitted", "The order passed all risk checks.");
      onDone();
    } catch (err) {
      toast.error("Trade submission failed", err instanceof Error ? err.message : "The order was not submitted.");
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
          <select id="mt-symbol" className="input cursor-pointer" value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value })} required>
            {!symbols.includes(form.symbol) && <option value={form.symbol}>{form.symbol}</option>}
            {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
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
        <div>
          <label htmlFor="mt-dur" className="label">Max duration</label>
          <select id="mt-dur" className="input cursor-pointer" value={form.durationMin}
            onChange={(e) => setForm({ ...form, durationMin: e.target.value })}>
            <option value="">No limit</option>
            <option value="60">1 hour</option>
            <option value="240">4 hours</option>
            <option value="480">8 hours</option>
            <option value="1440">1 day</option>
            <option value="4320">3 days</option>
          </select>
        </div>
        <button disabled={busy} className="btn-primary">{busy ? "Submitting…" : "Submit trade"}</button>
      </form>
    </section>
  );
}
