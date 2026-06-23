"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconDown, IconFlask, IconUp } from "@/components/icons";

interface Strategy { id: string; name: string }

interface BtTrade {
  signalTime: string; entryTime: string; exitTime: string; symbol: string; timeframe: string;
  direction: string; entryPrice: number; exitPrice: number; bidAtEntry: number; askAtEntry: number;
  bidAtExit: number; askAtExit: number; spreadPoints: number; slippagePoints: number;
  commission: number; atr: number; stopLoss: number; takeProfit: number; initialRiskAmount: number;
  lotSize: number; h4Trend: string; rsiPrevious: number | null; rsiCurrent: number | null;
  macdPrevious: number | null; macdCurrent: number | null; signalPrevious: number | null;
  signalCurrent: number | null; candlePattern: string | null; confidence: number;
  trailingActivatedAt: string | null; maximumFavorableExcursion: number; maximumAdverseExcursion: number;
  exitReason: string; sameBarAmbiguous: boolean; grossPnl: number; netPnl: number; rMultiple: number;
  grossRMultiple: number; spreadCost: number; slippageCost: number; balanceBefore: number;
  balanceAfter: number; session: string; reasons: string[];
  openTime: string; closeTime: string; lots: number; entry: number; exit: number; profit: number;
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
    grossProfit: number; grossLoss: number; averageWinningR: number | null; averageLosingR: number | null;
    payoffRatio: number | null; breakEvenWinRate: number | null; largestWinner: number | null;
    largestLoser: number | null; maxConsecutiveWins: number; maxConsecutiveLosses: number;
    longTradeCount: number; shortTradeCount: number; longWinRate: number | null; shortWinRate: number | null;
    longProfitFactor: number | null; shortProfitFactor: number | null; averageHoldingMinutes: number | null;
    medianHoldingMinutes: number | null; stopLossExitCount: number; takeProfitExitCount: number;
    trailingStopExitCount: number; breakEvenExitCount: number; endOfTestExitCount: number; sameBarAmbiguousExitCount: number;
    totalSpreadCost: number; totalCommission: number; totalSlippage: number;
  };
  equityCurve: { time: string; balance: number; equity: number; realizedPnl: number; unrealizedPnl: number }[];
  warnings: string[];
  dataQuality: { inputBars: number; normalizedBars: number; duplicatesRemoved: number; outOfOrderBars: number };
}

interface WfFold {
  fold: number; from: string; to: string; bars: number; trades: number;
  returnPct: number; profitFactor: number | null; winRate: number | null;
  maxDrawdownPct: number; expectancy: number | null;
}
interface WfResult {
  strategyName: string; symbol: string; timeframe: string;
  folds: WfFold[];
  consistency: {
    foldCount: number; profitableFolds: number; profitableFraction: number;
    meanReturnPct: number; stdevReturnPct: number; worstReturnPct: number;
    bestReturnPct: number; totalTrades: number; avgProfitFactor: number | null; verdict: string;
  };
  warnings: string[];
}

export function BacktestPanel() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [form, setForm] = useState({
    strategyId: "", symbol: "EURUSD", days: "365",
    initialBalance: "10000", spreadPoints: "15", slippagePoints: "2", commissionPerLot: "7", maxLotSize: "1",
    sameBarPolicy: "stop_first",
  });
  const [result, setResult] = useState<BtResult | null>(null);
  const [wf, setWf] = useState<WfResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wfBusy, setWfBusy] = useState(false);

  const loadStrategies = useCallback(async () => {
    try {
      const list = await api<Strategy[]>("/api/strategies");
      setStrategies(list);
      if (list.length && !form.strategyId) setForm((f) => ({ ...f, strategyId: list[0].id }));
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void loadStrategies(); }, [loadStrategies]);

  const payload = () => ({
    strategyId: form.strategyId, symbol: form.symbol, days: Number(form.days),
    initialBalance: Number(form.initialBalance), spreadPoints: Number(form.spreadPoints),
    slippagePoints: Number(form.slippagePoints), commissionPerLot: Number(form.commissionPerLot),
    maxLotSize: Number(form.maxLotSize), sameBarPolicy: form.sameBarPolicy,
  });

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    setResult(null);
    setWf(null);
    try {
      setResult(await api<BtResult>("/api/backtest", { method: "POST", body: payload() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "backtest failed");
    } finally {
      setBusy(false);
    }
  }

  async function runWf() {
    if (!form.strategyId) return;
    setError("");
    setWfBusy(true);
    setResult(null);
    setWf(null);
    try {
      setWf(await api<WfResult>("/api/backtest/walk-forward", { method: "POST", body: { ...payload(), folds: 4 } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "walk-forward failed");
    } finally {
      setWfBusy(false);
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
            <label htmlFor="bt-comm" className="label">Round-turn commission/lot</label>
            <input id="bt-comm" className={input} inputMode="decimal" value={form.commissionPerLot}
              onChange={(e) => setForm({ ...form, commissionPerLot: e.target.value })} />
          </div>
          <div>
            <label htmlFor="bt-same-bar" className="label">Same-bar SL + TP</label>
            <select id="bt-same-bar" className="input cursor-pointer" value={form.sameBarPolicy}
              onChange={(e) => setForm({ ...form, sameBarPolicy: e.target.value })}>
              <option value="stop_first">Stop first (conservative)</option>
              <option value="tp_first">Target first (comparison)</option>
            </select>
          </div>
          <div className="col-span-2 flex flex-wrap gap-2 md:col-span-4">
            <button disabled={busy || wfBusy || !form.strategyId} className="btn-primary">
              {busy ? "Running…" : "Run backtest"}
            </button>
            <button type="button" onClick={runWf} disabled={busy || wfBusy || !form.strategyId}
              className="btn bg-sky-950 text-sky-300 ring-1 ring-sky-900 hover:bg-sky-900 hover:text-sky-100">
              {wfBusy ? "Testing windows…" : "Walk-forward test"}
            </button>
            <span className="self-center text-xs text-ink-faint">
              Walk-forward splits the period into 4 windows and checks the edge holds in each — the honest robustness test.
            </span>
          </div>
        </form>
        {error && <p className="mt-3 text-sm text-down" role="alert">{error}</p>}
      </section>

      {wf && <WalkForwardResults wf={wf} />}

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
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Gross profit / loss" value={`${result.stats.grossProfit.toFixed(2)} / -${result.stats.grossLoss.toFixed(2)}`} />
              <Stat label="Payoff ratio" value={result.stats.payoffRatio?.toFixed(2) ?? "—"} />
              <Stat label="Break-even win rate" value={result.stats.breakEvenWinRate !== null ? `${result.stats.breakEvenWinRate}%` : "—"} />
              <Stat label="Average win / loss" value={`${result.stats.avgWin?.toFixed(2) ?? "—"} / -${result.stats.avgLoss?.toFixed(2) ?? "—"}`} />
              <Stat label="Average winning / losing R" value={`${result.stats.averageWinningR?.toFixed(2) ?? "—"} / ${result.stats.averageLosingR?.toFixed(2) ?? "—"}`} />
              <Stat label="Largest win / loss" value={`${result.stats.largestWinner?.toFixed(2) ?? "—"} / ${result.stats.largestLoser?.toFixed(2) ?? "—"}`} />
              <Stat label="Long / short" value={`${result.stats.longTradeCount} / ${result.stats.shortTradeCount}`} />
              <Stat label="SL / TP / BE / trail / end" value={`${result.stats.stopLossExitCount} / ${result.stats.takeProfitExitCount} / ${result.stats.breakEvenExitCount} / ${result.stats.trailingStopExitCount} / ${result.stats.endOfTestExitCount}`} />
              <Stat label="Spread cost" value={result.stats.totalSpreadCost.toFixed(2)} />
              <Stat label="Commission" value={result.stats.totalCommission.toFixed(2)} />
              <Stat label="Slippage cost" value={result.stats.totalSlippage.toFixed(2)} />
              <Stat label="Ambiguous bars" value={String(result.stats.sameBarAmbiguousExitCount)} />
            </div>
          </section>

          {result.equityCurve.length > 2 && (
            <section className="card">
              <h2 className="section-title">Equity curve <span className="font-normal text-ink-faint">final point is realized balance after liquidation</span></h2>
              <EquityChart curve={result.equityCurve} initial={Number(form.initialBalance)} />
            </section>
          )}

          <section className="card">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="section-title mb-0">Trades <span className="font-normal text-ink-faint">(last {Math.min(result.trades.length, 100)} of {result.trades.length})</span></h2>
              <div className="flex gap-2">
                <button type="button" className="btn" onClick={() => downloadDiagnostics(result, "json")}>Download JSON</button>
                <button type="button" className="btn" onClick={() => downloadDiagnostics(result, "csv")}>Download CSV</button>
              </div>
            </div>
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
                  {result.trades.slice(-100).reverse().map((t, i) => (
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

          <p className="text-xs text-ink-faint">
            Data checks: {result.dataQuality.normalizedBars.toLocaleString()} normalized bars,
            {` ${result.dataQuality.duplicatesRemoved}`} duplicates removed,
            {` ${result.dataQuality.outOfOrderBars}`} out-of-order inputs detected.
          </p>

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

function WalkForwardResults({ wf }: { wf: WfResult }) {
  const c = wf.consistency;
  const good = c.profitableFraction >= 0.75 && c.meanReturnPct > 0 && c.totalTrades >= c.foldCount * 5;
  const noEdge = c.profitableFraction < 0.5 || c.meanReturnPct <= 0;
  const tone = good ? "border-emerald-900/50 bg-emerald-950/20 text-up"
    : noEdge ? "border-red-900/50 bg-red-950/20 text-down"
      : "border-amber-900/50 bg-amber-950/20 text-warn";
  return (
    <>
      <section className="card">
        <h2 className="section-title">
          Walk-forward · {wf.strategyName} · {wf.symbol} {wf.timeframe}
          <span className="font-normal text-ink-faint">{c.foldCount} windows</span>
        </h2>
        <div className={`mb-4 rounded-xl border p-3 text-sm font-medium ${tone}`}>{c.verdict}</div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Profitable windows" value={`${c.profitableFolds}/${c.foldCount}`}
            tone={good ? "good" : noEdge ? "bad" : undefined} />
          <Stat label="Mean return / window" value={`${c.meanReturnPct >= 0 ? "+" : ""}${c.meanReturnPct}%`}
            tone={c.meanReturnPct > 0 ? "good" : "bad"} />
          <Stat label="Std dev (consistency)" value={`${c.stdevReturnPct}%`} />
          <Stat label="Worst → best" value={`${c.worstReturnPct}% → ${c.bestReturnPct}%`}
            tone={c.worstReturnPct < 0 ? "bad" : undefined} />
          <Stat label="Total trades" value={String(c.totalTrades)} />
          <Stat label="Avg profit factor" value={c.avgProfitFactor !== null ? String(c.avgProfitFactor) : "—"}
            tone={c.avgProfitFactor !== null ? (c.avgProfitFactor >= 1.3 ? "good" : c.avgProfitFactor < 1 ? "bad" : undefined) : undefined} />
        </div>
      </section>

      <section className="card">
        <h2 className="section-title">Per-window results</h2>
        <div className="overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-1.5 pr-3 font-medium">#</th><th className="pr-3 font-medium">Period</th>
                <th className="pr-3 font-medium">Trades</th><th className="pr-3 font-medium">Return</th>
                <th className="pr-3 font-medium">Win%</th><th className="pr-3 font-medium">PF</th>
                <th className="pr-3 font-medium">Max DD</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {wf.folds.map((f) => (
                <tr key={f.fold} className="border-t border-line">
                  <td className="py-1.5 pr-3 text-ink-faint">{f.fold}</td>
                  <td className="pr-3 text-ink-dim">{new Date(f.from).toLocaleDateString()} → {new Date(f.to).toLocaleDateString()}</td>
                  <td className="pr-3">{f.trades}</td>
                  <td className={`pr-3 font-medium ${f.returnPct >= 0 ? "text-up" : "text-down"}`}>{f.returnPct >= 0 ? "+" : ""}{f.returnPct}%</td>
                  <td className="pr-3 text-ink-dim">{f.winRate !== null ? `${f.winRate}%` : "—"}</td>
                  <td className="pr-3 text-ink-dim">{f.profitFactor ?? "—"}</td>
                  <td className="pr-3 text-ink-dim">{f.maxDrawdownPct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4 text-xs leading-relaxed text-warn">
        <p className="mb-1 font-semibold">How to read this:</p>
        <ul className="list-inside list-disc space-y-0.5">
          {wf.warnings.map((w, i) => <li key={i}>{w}</li>)}
          <li>An edge that holds in most windows earns a demo forward-test — never live money on a backtest alone.</li>
        </ul>
      </div>
    </>
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

const DIAGNOSTIC_COLUMNS: (keyof BtTrade)[] = [
  "signalTime", "entryTime", "exitTime", "symbol", "timeframe", "direction",
  "entryPrice", "exitPrice", "bidAtEntry", "askAtEntry", "bidAtExit", "askAtExit",
  "spreadPoints", "slippagePoints", "commission", "atr", "stopLoss", "takeProfit",
  "initialRiskAmount", "lotSize", "h4Trend", "rsiPrevious", "rsiCurrent", "macdPrevious",
  "macdCurrent", "signalPrevious", "signalCurrent", "candlePattern", "confidence",
  "trailingActivatedAt", "maximumFavorableExcursion", "maximumAdverseExcursion", "exitReason",
  "sameBarAmbiguous", "grossPnl", "netPnl", "rMultiple", "grossRMultiple", "spreadCost",
  "slippageCost", "balanceBefore", "balanceAfter", "session", "reasons",
];

function csvCell(value: unknown): string {
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadDiagnostics(result: BtResult, format: "json" | "csv") {
  const contents = format === "json"
    ? JSON.stringify({ metadata: { strategyName: result.strategyName, symbol: result.symbol, timeframe: result.timeframe, stats: result.stats }, trades: result.trades }, null, 2)
    : [
        DIAGNOSTIC_COLUMNS.join(","),
        ...result.trades.map((trade) => DIAGNOSTIC_COLUMNS.map((column) => csvCell(trade[column])).join(",")),
      ].join("\n");
  const blob = new Blob([contents], { type: format === "json" ? "application/json" : "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${result.strategyName}-${result.symbol}-${result.timeframe}-backtest.${format}`.replaceAll(" ", "-");
  anchor.click();
  URL.revokeObjectURL(url);
}
