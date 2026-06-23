"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface PaperTrade { id: string; symbol: string; direction: string; lots: number; status: string; entryPrice: number; exitPrice: number | null; profit: number | null; openedAt: string; }
interface Performance { trades: number; wins: number; losses: number; winRate: number; netPnl: number; profitFactor: number | null; }

export function PaperForwardPanel() {
  const [enabled, setEnabled] = useState(false);
  const [trades, setTrades] = useState<PaperTrade[] | null>(null);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [state, rows, stats] = await Promise.all([api<{ paperForward: boolean }>("/api/bot/state"), api<PaperTrade[]>("/api/paper-trades?limit=20"), api<Performance>("/api/paper-trades/performance")]);
      setEnabled(state.paperForward); setTrades(rows); setPerformance(stats); setError("");
    } catch (err) { setError(String(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const toggle = async () => { await api("/api/bot/paper-forward", { method: "POST", body: { enabled: !enabled } }); await load(); };
  return <section className="panel"><div className="mb-4 flex items-center justify-between"><div><p className="eyebrow">Forward test</p><h2 className="text-lg font-semibold">Paper-forward performance</h2></div><button className={enabled ? "btn-ghost" : "btn-primary"} onClick={() => void toggle()}>{enabled ? "Disable" : "Enable"}</button></div>
    {error && <p className="text-sm text-down">Could not load paper trades: {error}</p>}
    {performance && <div className="mb-3 grid grid-cols-3 gap-2 text-xs"><Metric label="Trades" value={performance.trades}/><Metric label="Win rate" value={`${performance.winRate}%`}/><Metric label="Net P/L" value={performance.netPnl.toFixed(2)}/></div>}
    {!error && trades === null && <p className="text-sm text-ink-faint">Loading paper-forward results...</p>}
    {!error && trades?.length === 0 && <p className="text-sm text-ink-faint">No paper-forward trades yet.</p>}
    <div className="space-y-2">{trades?.map((trade) => <div className="card flex items-center justify-between !p-3 text-xs" key={trade.id}><span><strong>{trade.direction} {trade.symbol}</strong> · {trade.lots} lots · {trade.status}</span><span className={Number(trade.profit ?? 0) >= 0 ? "text-up" : "text-down"}>{trade.profit === null ? "open" : trade.profit.toFixed(2)}</span></div>)}</div>
  </section>;
}

function Metric({ label, value }: { label: string; value: string | number }) { return <div className="card !p-3"><p className="text-ink-faint">{label}</p><strong className="tnum mt-1 block text-base">{value}</strong></div>; }
