"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconDown, IconFlask, IconUp } from "@/components/icons";

interface Strategy { id: string; name: string }

interface BtTrade {
  openTime: string; closeTime: string; direction: string; lots: number;
  entry: number; exit: number; profit: number; exitReason: string;
}

interface BtResult {
  strategyName: string;
  symbol: string;
  timeframe: string;
  bars: number;
  from: string;
  to: string;
  trades: BtTrade[];
  stats: {
    trades: number; wins: number; losses: number; winRate: number | null;
    profitFactor: number | null; expectancy: number | null; totalPnl: number;
    returnPct: number; maxDrawdownPct: number; maxLossStreak: number;
    avgWin: number | null; avgLoss: number | null; sharpe: number | null; finalBalance: number;
  };
  equityCurve: { time: string; equity: number }[];
  warnings: string[];
}

export function BacktestPanel() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [form, setForm] = useState({
    strategyId: "", symbol: "EURUSD", days: "365",
    initialBalance: "10000", spreadPoints: "15", slippagePoints: "2", commissionPerLot: "7", maxLotSize: "1",
  });
  const [result, setResult] = useState<BtResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStrategies = useCallback(async () => {
    try {
      const list = await api<Strategy[]>("/api/strategies");
      setStrategies(list);
      if (list.length && !form.strategyId) setForm((f) => ({ ...f, strategyId: list[0].id }));
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void loadStrategies(); }, [loadStrategies]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    setResult(null);
    try {
      const r = await api<BtResult>("/api/backtest", {
        method: "POST",
        body: {
          strategyId: form.strategyId, symbol: form.symbol, days: Number(form.days),
          initialBalance: Number(form.initialBalance), spreadPoints: Number(form.spreadPoints),
          slippagePoints: Number(form.slippagePoints), commissionPerLot: Number(form.commissionPerLot),
          maxLotSize: Number(form.maxLotSize),
        },
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "backtest failed");
    } finally {
      setBusy(false);
    }
  }

  const input = "input tnum";
  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="section-title"><IconFlask size={15} className="text-primary" /> Backtest a strategy</h2>
        <p className="mb-4 text-xs leading-relaxed text-ink-dim">
          Replays historical candles from your terminal through the exact strategy, sizing, and stop-management
          code the live bot runs. Signals execute at the next bar's open with spread and slippage; same-bar
          SL+TP resolves stop-first (conservative).
        </p>
        <form onSubmit={run} className="grid grid-cols-2 items-end gap-3 md:grid-cols-4">
          <div className="col-span-2">
            <label htmlFor="bt-strategy" className="label">Strategy</label>
            <select id="bt-strategy" className="input cursor-pointer" value={form.strategyId}
              onChange={(e) => setForm({ ...form, strategyId: e.target.value })} required>
              {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="bt-symbol" className="label">Symbol</label>
            <input id="bt-symbol" className="input" value={form.symbol}
              onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} required />
          </div>
          <div>
            <label htmlFor="bt-days" className="label">Period</label>
            <select id="bt-days" className="input cursor-pointer" value={form.days}
              onChange={(e) => setForm({ ...form, days: e.target.value })}>
              <option value="30">1 month</option>
              <option value="90">3 months</option>
              <option value="180">6 months</option>
              <option value="365">1 year</option>
              <option value="730">2 years</option>
            </select>
          </div>
          <div>
            <label htmlFor="bt-balance" className="label">Starting balance</label>
            <input id="bt-balance" className={input} inputMode="decimal" value={form.initialBalance}
              onChange={(e) => setForm({ ...form, initialBalance: e.target.value })} />
          </div>
          <div>
            <label htmlFor="bt-spread" className="label">Spread (pts)</label>
            <input id="bt-spread" className={input} inputMode="decimal" value={form.spreadPoints}
              onChange={(e) => setForm({ ...form, spreadPoints: e.target.value })} />
          </div>
          <div>
            <label htmlFor="bt-comm" className="label">Commission/lot</label>
            <input id="bt-comm" className={input} inputMode="decimal" value={form.commissionPerLot}
              onChange={(e) => setForm({ ...form, commissionPerLot: e.target.value })} />
          </div>
          <button disabled={busy || !form.strategyId} className="btn-primary">
            {busy ? "Running…" : "Run backtest"}
          </button>
        </form>
        {error && <p className="mt-3 text-sm text-down" role="alert">{error}</p>}
      </section>

      {result && (
        <>
          <section className="card">
            <h2 className="section-title">
              {result.strategyName} · {result.symbol} {result.timeframe}
              <span className="font-normal text-ink-faint">
                {new Date(result.from).toLocaleDateString()} → {new Date(result.to).toLocaleDateString()} ({result.bars.toLocaleString()} bars)
              </span>
            </h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Net return" value={`${result.stats.returnPct >= 0 ? "+" : ""}${result.stats.returnPct}%`}
                tone={result.stats.returnPct >= 0 ? "good" : "bad"} />
              <Stat label="Final balance" value={result.stats.finalBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} />
              <Stat label="Max drawdown" value={`${result.stats.maxDrawdownPct}%`}
                tone={result.stats.maxDrawdownPct > 20 ? "bad" : undefined} />
              <Stat label="Sharpe (ann.)" value={result.stats.sharpe?.toFixed(2) ?? "—"}
                tone={result.stats.sharpe !== null ? (result.stats.sharpe > 1 ? "good" : result.stats.sharpe < 0 ? "bad" : undefined) : undefined} />
              <Stat label="Trades" value={String(result.stats.trades)} />
              <Stat label="Win rate" value={result.stats.winRate !== null ? `${result.stats.winRate}%` : "—"} />
              <Stat label="Profit factor" value={String(result.stats.profitFactor ?? "—")}
                tone={result.stats.profitFactor !== null ? (result.stats.profitFactor >= 1.3 ? "good" : result.stats.profitFactor < 1 ? "bad" : undefined) : undefined} />
              <Stat label="Expectancy / trade" value={result.stats.expectancy?.toFixed(2) ?? "—"}
                tone={result.stats.expectancy !== null ? (result.stats.expectancy > 0 ? "good" : "bad") : undefined} />
            </div>
          </section>

          {result.equityCurve.length > 2 && (
            <section className="card">
              <h2 className="section-title">Equity curve</h2>
              <EquityChart curve={result.equityCurve} initial={Number(form.initialBalance)} />
            </section>
          )}

          <section className="card">
            <h2 className="section-title">Trades <span className="font-normal text-ink-faint">(last {result.trades.length})</span></h2>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface text-ink-faint">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Opened</th><th className="pr-3 font-medium">Dir</th>
                    <th className="pr-3 font-medium">Lots</th><th className="pr-3 font-medium">Entry → Exit</th>
                    <th className="pr-3 font-medium">Exit via</th><th className="pr-3 font-medium">P/L</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {[...result.trades].reverse().map((t, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1.5 pr-3 text-ink-faint">{new Date(t.openTime).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                      <td className={`pr-3 font-medium ${t.direction === "buy" ? "text-up" : "text-down"}`}>{t.direction.toUpperCase()}</td>
                      <td className="pr-3">{t.lots}</td>
                      <td className="pr-3 text-ink-dim">{t.entry.toFixed(5)} → {t.exit.toFixed(5)}</td>
                      <td className="pr-3 text-ink-faint">{t.exitReason}</td>
                      <td className={`pr-3 font-medium ${t.profit >= 0 ? "text-up" : "text-down"}`}>
                        {t.profit >= 0 ? "+" : ""}{t.profit.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4 text-xs leading-relaxed text-warn">
            <p className="mb-1 font-semibold">Read this before trusting the numbers:</p>
            <ul className="list-inside list-disc space-y-0.5">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              <li>Past performance never guarantees future results — a good backtest earns a demo forward-test, not live money.</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <div className="text-xs text-ink-faint">{label}</div>
      <div className={`tnum mt-0.5 text-lg font-semibold ${tone === "good" ? "text-up" : tone === "bad" ? "text-down" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}

function EquityChart({ curve, initial }: { curve: { time: string; equity: number }[]; initial: number }) {
  const w = 800;
  const h = 200;
  const values = curve.map((p) => p.equity);
  const min = Math.min(...values, initial);
  const max = Math.max(...values, initial);
  const span = max - min || 1;
  const x = (i: number) => (i / (curve.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / span) * (h - 10) - 5;
  const points = curve.map((p, i) => `${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  const up = last >= initial;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img"
      aria-label={`Equity curve from ${initial} to ${last}`}>
      <line x1="0" x2={w} y1={y(initial)} y2={y(initial)} stroke="var(--color-line-strong)" strokeDasharray="4 4" />
      <polyline points={points} fill="none" stroke={up ? "var(--color-up)" : "var(--color-down)"} strokeWidth="2" />
      <text x="4" y={y(initial) - 5} fill="var(--color-ink-faint)" fontSize="11" className="tnum">start {initial.toLocaleString()}</text>
      <text x={w - 4} y={y(last) - 8} fill={up ? "var(--color-up)" : "var(--color-down)"} fontSize="12" textAnchor="end" className="tnum">
        {last.toLocaleString("en-US", { maximumFractionDigits: 0 })}
      </text>
    </svg>
  );
}
