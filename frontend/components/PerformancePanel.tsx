"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Bucket {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  totalPnl: number;
  maxLossStreak: number;
  bestTrade: number | null;
  worstTrade: number | null;
}

interface Analytics {
  since: string;
  overall: Bucket;
  byStrategy: Bucket[];
  bySymbol: Bucket[];
  dailySeries: { date: string; pnl: number }[];
  unreconciledTrades: number;
}

export function PerformancePanel() {
  const [data, setData] = useState<Analytics | null>(null);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    try { setData(await api<Analytics>(`/api/analytics?days=${days}`)); } catch { /* noop */ }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  if (!data) return <p className="py-8 text-center text-sm text-ink-faint">Loading…</p>;
  const o = data.overall;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1.5">
        <span className="mr-1 text-xs text-ink-dim">Window</span>
        {[7, 30, 90].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={`btn btn-sm ${days === d ? "bg-primary-dim text-white" : "bg-surface-2 text-ink-dim ring-1 ring-line hover:text-ink"}`}>
            {d}d
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Closed trades" value={String(o.trades)} />
        <Card label="Win rate" value={o.winRate !== null ? `${o.winRate}%` : "—"}
          tone={o.winRate !== null ? (o.winRate >= 50 ? "good" : "bad") : undefined} />
        <Card label="Profit factor" value={o.profitFactor !== null ? String(o.profitFactor) : "—"}
          tone={o.profitFactor !== null ? (o.profitFactor >= 1.3 ? "good" : o.profitFactor < 1 ? "bad" : undefined) : undefined}
          hint="gross profit ÷ gross loss — above 1.3 is healthy" />
        <Card label="Expectancy / trade" value={o.expectancy !== null ? o.expectancy.toFixed(2) : "—"}
          tone={o.expectancy !== null ? (o.expectancy > 0 ? "good" : "bad") : undefined}
          hint="average P/L per trade — the number that actually matters" />
        <Card label="Total P/L" value={o.totalPnl.toFixed(2)} tone={o.totalPnl >= 0 ? "good" : "bad"} />
        <Card label="Avg win / loss" value={`${o.avgWin?.toFixed(2) ?? "—"} / ${o.avgLoss?.toFixed(2) ?? "—"}`} />
        <Card label="Worst loss streak" value={String(o.maxLossStreak)} />
        <Card label="Best / worst trade" value={`${o.bestTrade?.toFixed(2) ?? "—"} / ${o.worstTrade?.toFixed(2) ?? "—"}`} />
      </div>

      {data.dailySeries.length > 0 && (
        <section className="card">
          <h2 className="section-title">Daily P/L</h2>
          <DailyChart series={data.dailySeries} />
        </section>
      )}

      <BucketTable title="By strategy" buckets={data.byStrategy} />
      <BucketTable title="By symbol" buckets={data.bySymbol} />

      {o.trades === 0 && (
        <p className="rounded-xl border border-line bg-surface p-5 text-center text-sm text-ink-dim">
          No closed trades in this window yet. Let the bot run — every closed trade lands here with its
          realized P/L, so you can judge the system on real numbers instead of promises.
        </p>
      )}
      {data.unreconciledTrades > 0 && (
        <p className="text-xs text-warn">
          {data.unreconciledTrades} closed trade(s) awaiting profit reconciliation from broker history (excluded above).
        </p>
      )}
    </div>
  );
}

function Card({ label, value, tone, hint }: { label: string; value: string; tone?: "good" | "bad"; hint?: string }) {
  return (
    <div className="card card-hover" title={hint}>
      <div className="text-xs text-ink-faint">{label}</div>
      <div className={`tnum mt-1 truncate text-xl font-semibold ${tone === "good" ? "text-up" : tone === "bad" ? "text-down" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}

function DailyChart({ series }: { series: { date: string; pnl: number }[] }) {
  const max = Math.max(...series.map((d) => Math.abs(d.pnl)), 1);
  return (
    <div className="flex h-36 items-end gap-1" role="img" aria-label="Daily profit and loss bar chart">
      {series.map((d) => (
        <div key={d.date} className="group relative flex-1" title={`${d.date}: ${d.pnl.toFixed(2)}`}>
          <div
            className={`mx-auto w-full rounded-t transition-opacity hover:opacity-80 ${d.pnl >= 0 ? "bg-up" : "bg-down"}`}
            style={{ height: `${Math.max((Math.abs(d.pnl) / max) * 100, 4)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function BucketTable({ title, buckets }: { title: string; buckets: Bucket[] }) {
  if (!buckets.length) return null;
  return (
    <section className="card">
      <h2 className="section-title">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-ink-faint">
            <tr>
              <th className="py-1.5 pr-4 font-medium">Name</th><th className="pr-4 font-medium">Trades</th>
              <th className="pr-4 font-medium">Win rate</th><th className="pr-4 font-medium">Profit factor</th>
              <th className="pr-4 font-medium">Expectancy</th><th className="pr-4 font-medium">Total P/L</th>
            </tr>
          </thead>
          <tbody className="tnum text-ink">
            {buckets.map((b) => (
              <tr key={b.label} className="border-t border-line">
                <td className="py-2 pr-4 font-sans">{b.label}</td>
                <td className="pr-4">{b.trades}</td>
                <td className="pr-4">{b.winRate !== null ? `${b.winRate}%` : "—"}</td>
                <td className="pr-4">{b.profitFactor ?? "—"}</td>
                <td className={`pr-4 ${b.expectancy !== null && b.expectancy > 0 ? "text-up" : b.expectancy !== null ? "text-down" : ""}`}>
                  {b.expectancy?.toFixed(2) ?? "—"}
                </td>
                <td className={`pr-4 ${b.totalPnl >= 0 ? "text-up" : "text-down"}`}>{b.totalPnl.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
