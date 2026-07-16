"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ToastProvider";

type Filter = "ALL" | "OPEN" | "CLOSED" | "PROMOTED" | "CANCELLED";

interface PaperTrade {
  id: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  status: "OPEN" | "CLOSED" | "CANCELLED";
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  profit: number | null;
  openedAt: string;
  closedAt: string | null;
  promotedAt: string | null;
  promotedTradeId: string | null;
  strategy: { name: string } | null;
  promotedTrade: { id: string; status: string; mt5Ticket: string | null; entryPrice: number | null; openedAt: string | null } | null;
}

interface History {
  items: PaperTrade[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface Performance {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  profitFactor: number | null;
}

export function PaperForwardPanel() {
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [state, rows, stats] = await Promise.all([
        api<{ paperForward: boolean }>("/api/bot/state"),
        api<History>(`/api/paper-trades/history?status=${filter}&page=${page}&pageSize=25`),
        api<Performance>("/api/paper-trades/performance"),
      ]);
      setEnabled(state.paperForward);
      setHistory(rows);
      setPerformance(stats);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load paper trades.");
    }
  }, [filter, page]);

  useEffect(() => { void load(); }, [load]);

  async function toggle() {
    setBusy("toggle");
    try {
      await api("/api/bot/paper-forward", { method: "POST", body: { enabled: !enabled } });
      await load();
      toast.success("Paper-forward mode updated", enabled ? "Paper-forward trading is disabled." : "New passing setups can be recorded as paper trades.");
    } catch (err) { toast.error("Paper-forward update failed", err instanceof Error ? err.message : "Could not change paper-forward mode."); }
    finally { setBusy(null); }
  }

  async function executeAtBroker(trade: PaperTrade) {
    const confirmation = window.prompt(
      `BROKER EXECUTION\n\n${trade.direction} ${trade.symbol} from paper trade ${trade.id}.\n` +
      "The current market price and every risk/live gate will be checked again. On a REAL account this can lose real money.\n\nType EXECUTE to continue.",
    );
    if (confirmation !== "EXECUTE") return;

    const lotsText = window.prompt("Broker lot size", String(trade.lots));
    if (lotsText === null) return;
    const lots = Number(lotsText);
    if (!(lots > 0) || !Number.isFinite(lots)) {
      toast.error("Invalid lot size", "Enter a valid positive lot size.");
      return;
    }
    const totp = window.prompt("Enter your 2FA code if required for the connected real account. Otherwise leave blank.") ?? undefined;

    setBusy(`execute:${trade.id}`);
    try {
      const result = await api<{ ok: boolean; tradeId: string; status: string; isDemo: boolean; message: string }>(
        `/api/paper-trades/${trade.id}/execute`,
        { method: "POST", body: { confirmation: "EXECUTE", lots, ...(totp ? { totp } : {}) } },
      );
      toast.success("Broker trade submitted", `${result.message} ${result.isDemo ? "Sent to a DEMO account." : "Sent to the connected REAL account."} Trade ${result.tradeId}.`);
      await load();
    } catch (err) {
      toast.error("Broker execution failed", err instanceof Error ? err.message : "The trade was not submitted.");
    } finally { setBusy(null); }
  }

  return (
    <section className="panel">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Forward test</p>
          <h2 className="text-lg font-semibold">Paper-trade ledger</h2>
          <p className="mt-1 text-xs text-ink-faint">Complete paper history with a one-time, fully risk-gated broker conversion for open setups.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" disabled={busy !== null} onClick={() => void load()}>Refresh</button>
          <button className={enabled ? "btn-ghost" : "btn-primary"} disabled={busy !== null} onClick={() => void toggle()}>
            {busy === "toggle" ? "Updating…" : enabled ? "Disable paper-forward" : "Enable paper-forward"}
          </button>
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-down">Could not load paper trades: {error}</p>}
      {performance && (
        <div className="mb-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Metric label="Closed trades" value={performance.trades} />
          <Metric label="Win rate" value={`${performance.winRate}%`} />
          <Metric label="Net P/L" value={performance.netPnl.toFixed(2)} tone={performance.netPnl >= 0 ? "up" : "down"} />
          <Metric label="Profit factor" value={performance.profitFactor?.toFixed(2) ?? "—"} />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" aria-label="Filter paper trades">
          {(["ALL", "OPEN", "CLOSED", "PROMOTED", "CANCELLED"] as Filter[]).map((value) => (
            <button key={value} onClick={() => { setFilter(value); setPage(1); }}
              className={`btn btn-sm ${filter === value ? "bg-primary-dim text-primary" : "bg-surface-2 text-ink-dim"}`}>
              {value.toLowerCase()}
            </button>
          ))}
        </div>
        <span className="text-xs text-ink-faint">{history?.total ?? 0} trade{history?.total === 1 ? "" : "s"}</span>
      </div>

      {!error && history === null && <p className="text-sm text-ink-faint">Loading paper-forward results…</p>}
      {!error && history?.items.length === 0 && <p className="rounded-xl bg-surface-2 px-4 py-5 text-center text-sm text-ink-faint">No paper trades match this filter.</p>}

      <div className="space-y-2">
        {history?.items.map((trade) => (
          <article className="card !p-4 text-xs" key={trade.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`chip ${trade.direction === "BUY" ? "bg-emerald-950 text-up" : "bg-red-950 text-down"}`}>{trade.direction}</span>
                  <strong className="text-sm">{trade.symbol}</strong>
                  <span className="chip bg-surface-3 text-ink-dim">{trade.status.toLowerCase()}</span>
                  {trade.promotedTrade && <span className="chip bg-amber-950 text-warn">broker: {trade.promotedTrade.status.toLowerCase()}</span>}
                </div>
                <p className="mt-1 text-ink-faint">{trade.strategy?.name ?? "No strategy"} · opened {new Date(trade.openedAt).toLocaleString()}</p>
              </div>
              <div className={`tnum text-right text-sm font-semibold ${Number(trade.profit ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                {trade.profit === null ? "Open" : `${trade.profit >= 0 ? "+" : ""}${trade.profit.toFixed(2)}`}
              </div>
            </div>

            <div className="tnum mt-3 grid grid-cols-2 gap-2 rounded-xl bg-surface-2 px-3 py-2 sm:grid-cols-5">
              <Value label="Lots" value={trade.lots} />
              <Value label="Paper entry" value={trade.entryPrice} />
              <Value label="Stop loss" value={trade.stopLoss ?? "—"} />
              <Value label="Take profit" value={trade.takeProfit ?? "—"} />
              <Value label="Exit" value={trade.exitPrice ?? "—"} />
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="tnum text-ink-faint">ID {trade.id}{trade.promotedTrade?.mt5Ticket ? ` · MT5 ${trade.promotedTrade.mt5Ticket}` : ""}</span>
              {trade.status === "OPEN" && !trade.promotedAt && (
                <button className="btn-danger btn-sm" disabled={busy !== null} onClick={() => void executeAtBroker(trade)}>
                  {busy === `execute:${trade.id}` ? "Checking & submitting…" : "Execute as real trade"}
                </button>
              )}
              {trade.promotedAt && !trade.promotedTrade && <span className="text-warn">Broker submission locked — verify MT5 positions.</span>}
            </div>
          </article>
        ))}
      </div>

      {history && history.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <button className="btn-ghost btn-sm" disabled={page <= 1 || busy !== null} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button>
          <span className="tnum text-xs text-ink-faint">Page {history.page} of {history.totalPages}</span>
          <button className="btn-ghost btn-sm" disabled={page >= history.totalPages || busy !== null} onClick={() => setPage((value) => value + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "up" | "down" }) {
  return <div className="card !p-3"><p className="text-ink-faint">{label}</p><strong className={`tnum mt-1 block text-base ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : ""}`}>{value}</strong></div>;
}

function Value({ label, value }: { label: string; value: string | number }) {
  return <div><span className="block text-[10px] uppercase tracking-wide text-ink-faint">{label}</span><span className="mt-0.5 block">{value}</span></div>;
}
