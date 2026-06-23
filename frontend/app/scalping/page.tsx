"use client";
import { useCallback, useEffect, useState } from "react";
import { api, WS_URL } from "@/lib/api";
import { scalpingControlState } from "@/lib/scalping-controls";
import { IconZap, IconPlay, IconPause, IconStop, IconScan, IconShield, IconUp, IconDown, IconWallet, IconRefresh } from "@/components/icons";
import { Sidebar, MobileNav, SCALPING_NAV_ID } from "@/components/Sidebar";
import { ActivityPanel } from "@/components/ActivityPanel";

/**
 * Keep only scalping-mode events in the shared live activity feed. All scalping
 * audit entries either use a "scalping*" actor (scalping:auto / :ai / :manager /
 * :run-once) or a "scalp*" action (scalp_opened, scalp_closed, scalp_ai_decision,
 * scalping_running/_paused/_stopped, scalping_config_updated, ...).
 */
function isScalpingEvent(e: { actor: string; action: string }): boolean {
  return e.actor.startsWith("scalping") || e.action.toLowerCase().startsWith("scalp");
}

// ---- API shapes (mirror backend/src/modules/scalping) ----
interface ScalpConfig {
  enabled: boolean; status: "running" | "paused" | "stopped"; symbols: string[];
  useAiFireControl: boolean; aiMode: "STRICT" | "ADVISORY" | "PURE_LOGIC"; minAiConfidence: number; aiDecisionTtlSeconds: number;
}
interface ScalpRisk {
  scalpingRiskPreset: "low" | "medium" | "aggressive" | "custom";
  lotMode: "fixed" | "risk_percent"; riskPerTradePercent: number; allowFixedLot: boolean;
  maxOpenTradesTotal: number; maxTradesPerSymbol: number; targetProfitMoney: number; maxLossMoney: number;
  stopBasis: "money" | "points"; takeProfitPoints: number | null; stopLossPoints: number | null; profitTargetMoney: number | null;
  maxLotSize: number;
  reentryAfterWinSeconds: number; reentryAfterLossSeconds: number; maxTradesPerDay: number; maxConsecutiveLosses: number;
  pauseAfterLossStreakMinutes: number; dailyLossLimitMoney: number | null; dailyLossLimitPercent: number | null;
  maxSharedCurrencyExposure: number; maxSpreadPointsBySymbol: Record<string, number>;
  allowedSessions: string[]; pauseDuringNews: boolean; pauseBeforeNewsMin: number; pauseAfterNewsMin: number; newsRiskLimit: "LOW" | "MEDIUM" | "HIGH"; flattenBeforeHighImpactNews: boolean;
}
interface ScalpSummary {
  status: string; openCount: number; maxOpen: number; dailyPnl: number; lossStreak: number;
  aiFireControl: { enabled: boolean; mode: string; minConfidence: number };
  activeSymbols: string[]; currencyExposure: Record<string, number>; maxSharedCurrencyExposure: number;
}
interface ScalpState { config: ScalpConfig; risk: ScalpRisk; status: string; active: { symbol: string; ticket: string | null }[]; summary: ScalpSummary; }
interface Trade { id: string; symbol: string; direction: string; status: string; lots: number; profit: number | null; createdAt: string; explanation?: { closeReason?: string }; }
interface AiDecision { symbol: string; decision: string; confidence: number; riskLevel: string; reasoning: string; validUntil: string; valid: boolean; }
interface Overview {
  account: { balance: number; equity: number; margin: number; free_margin: number; margin_level: number; currency: string; is_demo: boolean };
  botState: { status: string; mode: string; emergencyStop: boolean; demoMode: boolean; liveTradingEnabled: boolean; paperForward: boolean };
  openTrades: { ticket: string; symbol: string; type: string; volume: number; price_open: number; price_current?: number; sl: number | null; tp: number | null; profit: number; time?: string }[];
  floatingPnl: number;
  dailyPnl: number;
}

function fmt(n: number, d = 2) { return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function clsStatus(s: string) {
  return s === "running" ? { dot: "bg-up", text: "text-up", label: "Running" }
    : s === "paused" ? { dot: "bg-warn", text: "text-warn", label: "Paused" }
    : { dot: "bg-ink-faint", text: "text-ink-dim", label: "Stopped" };
}

export default function ScalpingPage() {
  const [state, setState] = useState<ScalpState | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [decisions, setDecisions] = useState<AiDecision[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    // Resilient: a single failing/slow endpoint must NOT blank the whole page
    // (which would reset the controls to "stopped" and hide the balances).
    const [s, t, d, o] = await Promise.allSettled([
      api<ScalpState>("/api/scalping"),
      api<Trade[]>("/api/scalping/trades?limit=25"),
      api<{ recent: AiDecision[] }>("/api/scalping/ai-decisions"),
      api<Overview>("/api/overview"),
    ]);
    if (s.status === "fulfilled") setState(s.value);
    if (t.status === "fulfilled") setTrades(t.value);
    if (d.status === "fulfilled") setDecisions(d.value.recent ?? []);
    if (o.status === "fulfilled") setOverview(o.value);
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 5000);
    let ws: WebSocket | null = null; let stopped = false; let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(WS_URL);
      ws.onmessage = (m) => { try { const { event } = JSON.parse(m.data); if (event === "scalping" || event === "trade" || event === "floating_pnl") void refresh(); } catch { /* ignore */ } };
      ws.onclose = () => { if (!stopped) retry = setTimeout(connect, 2000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => { stopped = true; clearInterval(interval); if (retry) clearTimeout(retry); ws?.close(); };
  }, [refresh]);

  async function control(path: string, body?: unknown) {
    setBusy(true); setMsg("");
    try { const r = await api<unknown>(path, { method: "POST", body: body ?? {} }); setMsg(typeof r === "object" ? "Done." : String(r)); await refresh(); }
    catch (e) { setMsg(e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }

  async function runOnce() {
    setBusy(true); setMsg("Running one cycle…");
    try {
      const r = await api<{ entries: { opened: unknown[]; blocked: { symbol?: string; reason: string }[] }; plansRefreshed: number }>("/api/scalping/run-once", { method: "POST", body: {} });
      const blocked = r.entries.blocked.map((b) => b.symbol && b.symbol !== "*" ? `${b.symbol}: ${b.reason}` : b.reason).join("; ");
      setMsg(`Cycle done — ${r.entries.opened.length} opened, ${r.entries.blocked.length} blocked, ${r.plansRefreshed} AI plan(s) refreshed.${blocked ? ` Blocked: ${blocked}` : ""}`);
      await refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Run failed"); }
    finally { setBusy(false); }
  }

  async function saveConfig(patch: Partial<ScalpConfig>) {
    setMsg("");
    try { await api("/api/scalping", { method: "PUT", body: patch }); await refresh(); setMsg("Saved."); }
    catch (e) { setMsg(e instanceof Error ? e.message : "Save failed"); }
  }
  async function saveRisk(patch: Partial<ScalpRisk>) {
    setMsg("");
    try { await api("/api/scalping/risk-settings", { method: "PUT", body: patch }); await refresh(); setMsg("Saved."); }
    catch (e) { setMsg(e instanceof Error ? e.message : "Save failed"); }
  }
  async function applyPreset(preset: "low" | "medium" | "aggressive") {
    if (preset === "aggressive" && !confirm("Aggressive preset: up to 1% risk/trade and 5% total exposure. Higher drawdown — still hard-capped. Apply to your LIVE config?")) return;
    setMsg("");
    try { await api("/api/scalping/preset", { method: "POST", body: { preset } }); await refresh(); setMsg(`Applied ${preset} preset.`); }
    catch (e) { setMsg(e instanceof Error ? e.message : "Apply failed"); }
  }

  const sm = state?.summary;
  const st = clsStatus(sm?.status ?? "stopped");
  const isEmergency = !!overview?.botState.emergencyStop;
  const controls = scalpingControlState(sm?.status ?? "stopped", isEmergency);
  const openPositionByTicket = new Map((overview?.openTrades ?? []).map((p) => [p.ticket, p]));

  return (
    <div className="flex min-h-dvh">
      <Sidebar active={SCALPING_NAV_ID} />
      <div className="min-w-0 flex-1">
        {/* Mobile header + nav (sidebar is desktop-only) */}
        <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur lg:hidden">
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-dim text-white"><IconZap size={15} /></span>
            <span className="text-sm font-semibold">Scalping Mode</span>
          </div>
          <MobileNav active={SCALPING_NAV_ID} />
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="hidden h-10 w-10 items-center justify-center rounded-xl bg-primary-dim text-white lg:flex"><IconZap size={20} /></span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Scalping Mode</h1>
            <div className="text-xs text-ink-faint">Multi-Pair Sequential Scalper</div>
          </div>
        </div>
        {overview && (
          <div className="text-right">
            <div className="tnum text-base font-semibold leading-tight">
              {fmt(overview.account.balance)} <span className="text-xs font-normal text-ink-faint">{overview.account.currency}</span>
            </div>
            <div className={`tnum flex items-center justify-end gap-1 text-xs ${overview.floatingPnl >= 0 ? "text-up" : "text-down"}`}>
              {overview.floatingPnl >= 0 ? <IconUp size={12} /> : <IconDown size={12} />}
              {overview.floatingPnl >= 0 ? "+" : ""}{fmt(overview.floatingPnl)} floating
            </div>
          </div>
        )}
      </div>

      {/* Experimental note */}
      <div className="mb-5 rounded-xl border border-amber-900/70 bg-amber-950/40 px-4 py-3 text-xs text-amber-200">
        <strong>Scalping Mode is experimental.</strong> The AI is a gate, not a guarantee. It never bypasses the global risk
        engine. Test in demo / paper-forward before going live. Money targets are tiny by design — broker SL/TP are protective
        backstops; the worker closes on floating P&amp;L every second.
      </div>

      {overview && <AccountSnapshot data={overview} />}

      {/* 1. Status cards */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Scalping Mode">
          <span className={`inline-flex items-center gap-1.5 text-base font-semibold ${st.text}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${st.dot} ${sm?.status === "running" ? "animate-pulse" : ""}`} />{st.label}
          </span>
        </Card>
        <Card label="Open scalps"><span className="tnum text-xl font-semibold">{sm?.openCount ?? 0}<span className="text-sm text-ink-faint"> / {sm?.maxOpen ?? 0}</span></span></Card>
        <Card label="Daily scalping P/L">
          <span className={`tnum text-xl font-semibold ${(sm?.dailyPnl ?? 0) >= 0 ? "text-up" : "text-down"}`}>
            {(sm?.dailyPnl ?? 0) >= 0 ? "+" : ""}{fmt(sm?.dailyPnl ?? 0)}
          </span>
        </Card>
        <Card label="Loss streak"><span className={`tnum text-xl font-semibold ${(sm?.lossStreak ?? 0) > 0 ? "text-down" : "text-ink"}`}>{sm?.lossStreak ?? 0}</span></Card>
        <Card label="AI fire control">
          <span className={`chip ${sm?.aiFireControl.enabled ? "bg-emerald-950 text-up" : "bg-surface-3 text-ink-dim"}`}>
            <IconShield size={11} /> {sm?.aiFireControl.enabled ? `${sm.aiFireControl.mode}` : "Off"}
          </span>
        </Card>
        <Card label="Active symbols"><span className="text-sm font-medium">{sm?.activeSymbols.length ? sm.activeSymbols.join(", ") : "none"}</span></Card>
        <Card label="Currency exposure">
          <span className="text-sm font-medium">
            {sm && Object.keys(sm.currencyExposure).length ? Object.entries(sm.currencyExposure).map(([c, n]) => `${c}:${n}`).join("  ") : "none"}
          </span>
          <div className="mt-0.5 text-[11px] text-ink-faint">cap {sm?.maxSharedCurrencyExposure ?? 2}/ccy</div>
        </Card>
        <Card label="AI confidence floor"><span className="tnum text-xl font-semibold">{Math.round((sm?.aiFireControl.minConfidence ?? 0) * 100)}%</span></Card>
      </div>

      {/* 9. Controls */}
      <div className="card mt-5">
        <div className="mb-2 text-sm font-semibold">Controls</div>
        <div className="flex flex-wrap gap-2">
          <button
            className={`btn bg-emerald-900 text-emerald-200 ring-1 ring-emerald-800 hover:bg-emerald-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-emerald-900 disabled:hover:text-emerald-200 ${controls.running ? "ring-2 ring-emerald-400" : ""}`}
            disabled={busy || controls.startDisabled}
            onClick={() => control("/api/scalping/start")}>
            <IconPlay size={14} /> {controls.startLabel}
          </button>
          <button
            className="btn bg-amber-950 text-amber-300 ring-1 ring-amber-900 hover:bg-amber-900 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-amber-950 disabled:hover:text-amber-300"
            disabled={busy || controls.pauseDisabled}
            onClick={() => control("/api/scalping/pause")}>
            <IconPause size={14} /> {controls.pauseLabel}
          </button>
          <button className="btn" disabled={busy || controls.stopDisabled} onClick={() => control("/api/scalping/stop")}><IconStop size={14} /> Stop</button>
          {isEmergency && (
            <button className="btn-ghost" disabled={busy} onClick={() => control("/api/bot/emergency-reset")}>
              <IconRefresh size={14} /> Reset emergency stop
            </button>
          )}
          <button className="btn" disabled={busy || isEmergency} onClick={runOnce}><IconScan size={14} /> Run once</button>
          <button
            className="btn-danger ml-auto"
            disabled={busy}
            onClick={() => { if (confirm("EMERGENCY STOP halts the bot and closes ALL open positions. Continue?")) void control("/api/bot/emergency-stop"); }}>
            Emergency stop
          </button>
        </div>
        {msg && <div className="mt-2 text-xs text-ink-dim">{msg}</div>}
      </div>

      {/* Live activity (scalping-scoped) */}
      <div className="mt-5">
        <ActivityPanel title="Live scalping activity" eventFilter={isScalpingEvent} />
      </div>

      {state && (
        <PresetSelector risk={state.risk} balance={overview?.account.balance ?? null} onApply={applyPreset} />
      )}

      {state && (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          {/* 2. Symbol selection */}
          <SymbolForm config={state.config} onSave={saveConfig} />
          {/* 3. AI Fire Control */}
          <AiForm config={state.config} onSave={saveConfig} />
          {/* 4. Scalping risk settings */}
          <RiskForm risk={state.risk} onSave={saveRisk} />
          {/* 5. Execution settings */}
          <ExecutionForm risk={state.risk} onSave={saveRisk} />
        </div>
      )}

      {/* 6. Active scalping trades */}
      <Section title="Active scalping trades">
        {state?.active.length ? (
          <Table
            head={["Symbol", "Ticket", "Current P/L"]}
            rows={state.active.map((a) => {
              const position = a.ticket ? openPositionByTicket.get(a.ticket) : undefined;
              return [
                a.symbol,
                a.ticket ?? "—",
                position ? `${position.profit >= 0 ? "+" : ""}${fmt(position.profit)}` : "—",
              ];
            })}
          />
        ) : <Empty>No active scalping trades.</Empty>}
      </Section>

      {/* 7. Recent AI decisions */}
      <Section title="Recent AI decisions">
        {decisions.length ? (
          <Table
            head={["Symbol", "Decision", "Conf.", "Risk", "Valid", "Reasoning"]}
            rows={decisions.map((d) => [
              d.symbol,
              d.decision.toUpperCase(),
              `${Math.round(d.confidence * 100)}%`,
              d.riskLevel,
              d.valid ? "yes" : "no",
              d.reasoning.slice(0, 80),
            ])}
          />
        ) : <Empty>No AI decisions yet. Start scalping or run once to populate.</Empty>}
      </Section>

      {/* 8. Scalping performance + recent trades */}
      <Section title="Recent scalping trades">
        {trades.length ? (
          <Table
            head={["Time", "Symbol", "Dir", "Status", "Lots", "P/L", "Close reason"]}
            rows={trades.map((t) => [
              new Date(t.createdAt).toLocaleTimeString(),
              t.symbol, t.direction, t.status, fmt(t.lots, 2),
              t.profit == null ? "—" : `${t.profit >= 0 ? "+" : ""}${fmt(t.profit)}`,
              t.explanation?.closeReason ?? "—",
            ])}
          />
        ) : <Empty>No scalping trades yet.</Empty>}
      </Section>

      <ScalpPerformance />
        </main>
      </div>
    </div>
  );
}

// ---------- small building blocks ----------
function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="mb-1 text-xs text-ink-faint">{label}</div>
      {children}
    </div>
  );
}
function AccountSnapshot({ data }: { data: Overview }) {
  const a = data.account;
  const stats: { label: string; value: string; sub?: string; tone?: "up" | "down" }[] = [
    { label: "Balance", value: `${fmt(a.balance)} ${a.currency}` },
    { label: "Equity", value: fmt(a.equity) },
    { label: "Free margin", value: fmt(a.free_margin) },
    { label: "Margin level", value: a.margin_level > 0 ? `${a.margin_level.toFixed(0)}%` : "—" },
    {
      label: "Daily P/L",
      value: `${data.dailyPnl >= 0 ? "+" : ""}${fmt(data.dailyPnl)}`,
      tone: data.dailyPnl >= 0 ? "up" : "down",
    },
    {
      label: "Floating P/L",
      value: `${data.floatingPnl >= 0 ? "+" : ""}${fmt(data.floatingPnl)}`,
      sub: `${data.openTrades.length} open trade${data.openTrades.length === 1 ? "" : "s"}`,
      tone: data.floatingPnl >= 0 ? "up" : "down",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      {stats.map((stat) => (
        <div key={stat.label} className="card card-hover">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-ink-faint">
            {stat.label === "Balance" && <IconWallet size={13} />}
            {stat.label}
          </div>
          <div className={`tnum text-xl font-semibold ${stat.tone === "up" ? "text-up" : stat.tone === "down" ? "text-down" : ""}`}>
            {stat.value}
          </div>
          {stat.sub && <div className="mt-1 truncate text-[11px] text-ink-faint">{stat.sub}</div>}
        </div>
      ))}
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="card mt-5"><div className="mb-3 text-sm font-semibold">{title}</div>{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) { return <div className="py-6 text-center text-xs text-ink-faint">{children}</div>; }
function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead><tr className="text-ink-faint">{head.map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">{r.map((c, j) => <td key={j} className="tnum px-2 py-1.5">{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function NumberField({ label, value, onChange, step = 1, min }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input type="number" className="input" value={value} step={step} min={min}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/**
 * Form state seeded from a server value, re-synced ONLY when the value's CONTENT
 * changes. The page polls every 5s and hands each form a fresh-but-identical
 * object every tick; a naive `useEffect(() => setF(v), [v])` then wipes any edit
 * in progress. Keying the resync on a content signature fixes that.
 */
function useServerForm<T>(value: T) {
  const [state, setState] = useState(value);
  const sig = JSON.stringify(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setState(value), [sig]);
  return [state, setState] as const;
}

const PRESET_META: Record<"low" | "medium" | "aggressive", {
  label: string; riskPct: number; maxOpen: number; dailyLoss: number; cap: number; conf: number;
  purpose: string; recommended: boolean; warn?: boolean;
}> = {
  low: { label: "Low Risk", riskPct: 0.25, maxOpen: 2, dailyLoss: 2, cap: 1, conf: 0.82, purpose: "Capital protection, slow growth", recommended: true },
  medium: { label: "Medium Risk", riskPct: 0.5, maxOpen: 3, dailyLoss: 4, cap: 2, conf: 0.76, purpose: "Balanced growth, controlled drawdown", recommended: true },
  aggressive: { label: "Aggressive", riskPct: 1.0, maxOpen: 5, dailyLoss: 7, cap: 5, conf: 0.68, purpose: "Faster growth, higher drawdown — still hard-capped", recommended: false, warn: true },
};

function PresetSelector({ risk, balance, onApply }: {
  risk: ScalpRisk; balance: number | null; onApply: (p: "low" | "medium" | "aggressive") => void;
}) {
  const active = risk.scalpingRiskPreset;
  const isRiskMode = risk.lotMode === "risk_percent";
  const maxLossPerTrade = balance != null ? balance * (risk.riskPerTradePercent / 100) : null;
  const totalExposurePct = risk.maxOpenTradesTotal * risk.riskPerTradePercent;
  const activeCap = active === "low" ? 1 : active === "medium" ? 2 : 5;
  return (
    <div className="mt-5 card">
      <div className="mb-1 text-sm font-semibold">Risk preset</div>
      <div className="mb-3 text-xs text-ink-dim">
        A preset sets how <b>much</b> you risk per trade, not whether the strategy wins. Lot size is risk-based — a multiplier sized off your stop, never a profit target.
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(["low", "medium", "aggressive"] as const).map((key) => {
          const m = PRESET_META[key];
          const selected = active === key;
          return (
            <button key={key} onClick={() => onApply(key)}
              className={`rounded-xl border p-3 text-left transition ${selected ? "border-primary bg-primary/10" : "border-line hover:border-line-strong"}`}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{m.label}</span>
                {selected && <span className="chip bg-primary/15 text-primary">Active</span>}
              </div>
              <div className="mt-1 text-xs text-ink-dim">{m.purpose}</div>
              <div className="tnum mt-2 space-y-0.5 text-xs">
                <div>Risk/trade <b>{m.riskPct}%</b> · Max open <b>{m.maxOpen}</b></div>
                <div>Daily loss <b>{m.dailyLoss}%</b> · Exposure ≤ <b>{m.cap}%</b></div>
                <div>AI conf ≥ <b>{m.conf}</b></div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {m.recommended && <span className="chip bg-up/15 text-up">Recommended for $500</span>}
                {m.warn && <span className="chip bg-warn/20 text-warn">⚠ Higher drawdown</span>}
              </div>
            </button>
          );
        })}
        <div className={`rounded-xl border p-3 ${active === "custom" ? "border-primary bg-primary/10" : "border-line"}`}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Custom</span>
            {active === "custom" && <span className="chip bg-primary/15 text-primary">Active</span>}
          </div>
          <div className="mt-1 text-xs text-ink-dim">Hand-tuned. Editing any field below switches the preset to Custom.</div>
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div><div className="label">Lot mode</div><div className="tnum text-sm font-semibold">{isRiskMode ? `Risk ${risk.riskPerTradePercent}%` : "Fixed lot"}</div></div>
        <div><div className="label">Max loss / trade</div><div className="tnum text-sm font-semibold">{isRiskMode && maxLossPerTrade != null ? `~$${fmt(maxLossPerTrade)}` : "—"}</div></div>
        <div><div className="label">Total exposure (all slots)</div><div className="tnum text-sm font-semibold">{isRiskMode ? `${fmt(totalExposurePct, 2)}% / cap ${activeCap}%` : "—"}</div></div>
      </div>
      {active === "aggressive" && (
        <div className="mt-2 text-xs text-warn">⚠ Aggressive: faster growth but larger drawdowns. Hard limits (daily-loss, consecutive-loss, exposure cap, spread, news) still apply.</div>
      )}
    </div>
  );
}

function SymbolForm({ config, onSave }: { config: ScalpConfig; onSave: (p: Partial<ScalpConfig>) => void }) {
  const joined = config.symbols.join(", ");
  const [text, setText] = useState(joined);
  useEffect(() => setText(joined), [joined]);
  return (
    <div className="card">
      <div className="mb-3 text-sm font-semibold">Symbol selection</div>
      <label className="block">
        <span className="label">Watchlist (comma-separated, different pairs)</span>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="EURUSD, GBPUSD, USDJPY" />
      </label>
      <button className="btn-primary mt-3"
        onClick={() => onSave({ symbols: text.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) })}>
        Save symbols
      </button>
    </div>
  );
}

function AiForm({ config, onSave }: { config: ScalpConfig; onSave: (p: Partial<ScalpConfig>) => void }) {
  const [f, setF] = useServerForm(config);
  return (
    <div className="card">
      <div className="mb-3 text-sm font-semibold">AI fire control</div>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.useAiFireControl} onChange={(e) => setF({ ...f, useAiFireControl: e.target.checked })} />
        Use AI fire control (gate fires in the technical direction)
      </label>
      <label className="mb-3 block">
        <span className="label">AI mode</span>
        <select className="input" value={f.aiMode} onChange={(e) => setF({ ...f, aiMode: e.target.value as "STRICT" | "ADVISORY" | "PURE_LOGIC" })}>
          <option value="STRICT">STRICT — must agree + confidence</option>
          <option value="ADVISORY">ADVISORY — logs, blocks only strong avoid/high risk</option>
          <option value="PURE_LOGIC">PURE LOGIC — no AI, technicals + risk only</option>
        </select>
        {f.aiMode === "PURE_LOGIC" && (
          <span className="mt-1 block text-xs text-ink-dim">No model is called in this mode — the technical signal and risk gates decide every entry (overrides the toggle above).</span>
        )}
      </label>
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Min AI confidence (0–1)" value={f.minAiConfidence} step={0.01} min={0} onChange={(v) => setF({ ...f, minAiConfidence: v })} />
        <NumberField label="AI decision TTL (s)" value={f.aiDecisionTtlSeconds} min={10} onChange={(v) => setF({ ...f, aiDecisionTtlSeconds: v })} />
      </div>
      <button className="btn-primary mt-3" onClick={() => onSave({ useAiFireControl: f.useAiFireControl, aiMode: f.aiMode, minAiConfidence: f.minAiConfidence, aiDecisionTtlSeconds: f.aiDecisionTtlSeconds })}>Save AI settings</button>
    </div>
  );
}

function RiskForm({ risk, onSave }: { risk: ScalpRisk; onSave: (p: Partial<ScalpRisk>) => void }) {
  const [f, setF] = useServerForm(risk);
  return (
    <div className="card">
      <div className="mb-3 text-sm font-semibold">Scalping risk settings</div>
      <label className="mb-3 block">
        <span className="label">Per-trade TP/SL basis</span>
        <select className="input" value={f.stopBasis} onChange={(e) => setF({ ...f, stopBasis: e.target.value as "money" | "points" })}>
          <option value="money">Money ($) — take profit / stop loss in dollars</option>
          <option value="points">Points — take profit / stop loss in price points</option>
        </select>
        {f.stopBasis === "points" && (f.takeProfitPoints == null || f.stopLossPoints == null) && (
          <span className="mt-1 block text-xs text-warn">Set both TP and SL points below, or it falls back to the $ values.</span>
        )}
      </label>
      <label className="mb-3 block">
        <span className="label">Lot sizing</span>
        <select className="input" value={f.lotMode} onChange={(e) => setF({ ...f, lotMode: e.target.value as "fixed" | "risk_percent" })}>
          <option value="fixed">Fixed — broker-minimum lot, capped by max lot size</option>
          <option value="risk_percent">Risk % — size each trade off the stop to risk a % of balance</option>
        </select>
        {f.lotMode === "risk_percent" && (f.stopBasis !== "points" || f.stopLossPoints == null) && (
          <span className="mt-1 block text-xs text-warn">Risk % sizing needs the Points basis with a stop-loss set; otherwise it falls back to fixed lot.</span>
        )}
      </label>
      <div className="grid grid-cols-2 gap-3">
        {f.lotMode === "risk_percent" && <NumberField label="Risk per trade (%)" value={f.riskPerTradePercent} step={0.05} min={0.01} onChange={(v) => setF({ ...f, riskPerTradePercent: v })} />}
        <NumberField label="Max open total (1–10)" value={f.maxOpenTradesTotal} min={1} onChange={(v) => setF({ ...f, maxOpenTradesTotal: v })} />
        <NumberField label="Max per symbol (v1 = 1)" value={f.maxTradesPerSymbol} min={1} onChange={(v) => setF({ ...f, maxTradesPerSymbol: v })} />
        <NumberField label="Take profit ($)" value={f.targetProfitMoney} step={0.01} min={0.01} onChange={(v) => setF({ ...f, targetProfitMoney: v })} />
        <NumberField label="Stop loss ($)" value={f.maxLossMoney} step={0.01} min={0.01} onChange={(v) => setF({ ...f, maxLossMoney: v })} />
        {f.stopBasis === "points" && <NumberField label="Take profit (points)" value={f.takeProfitPoints ?? 0} min={0} onChange={(v) => setF({ ...f, takeProfitPoints: v > 0 ? v : null })} />}
        {f.stopBasis === "points" && <NumberField label="Stop loss (points)" value={f.stopLossPoints ?? 0} min={0} onChange={(v) => setF({ ...f, stopLossPoints: v > 0 ? v : null })} />}
        <NumberField label="Profit goal — stop ($, 0 = off)" value={f.profitTargetMoney ?? 0} step={0.01} min={0} onChange={(v) => setF({ ...f, profitTargetMoney: v > 0 ? v : null })} />
        <NumberField label="Max lot size" value={f.maxLotSize} step={0.01} min={0.01} onChange={(v) => setF({ ...f, maxLotSize: v })} />
        <NumberField label="Max trades/day" value={f.maxTradesPerDay} min={1} onChange={(v) => setF({ ...f, maxTradesPerDay: v })} />
        <NumberField label="Max consecutive losses" value={f.maxConsecutiveLosses} min={1} onChange={(v) => setF({ ...f, maxConsecutiveLosses: v })} />
        <NumberField label="Pause after streak (min)" value={f.pauseAfterLossStreakMinutes} min={0} onChange={(v) => setF({ ...f, pauseAfterLossStreakMinutes: v })} />
        <NumberField label="Daily loss limit (%)" value={f.dailyLossLimitPercent ?? 0} step={0.1} min={0} onChange={(v) => setF({ ...f, dailyLossLimitPercent: v })} />
        <NumberField label="Max shared currency exposure" value={f.maxSharedCurrencyExposure} min={1} onChange={(v) => setF({ ...f, maxSharedCurrencyExposure: v })} />
      </div>
      {f.maxTradesPerSymbol > 1 && <div className="mt-2 text-xs text-warn">v1 supports exactly 1 active trade per symbol — values above 1 are rejected on save.</div>}
      <button className="btn-primary mt-3" onClick={() => onSave({
        lotMode: f.lotMode, riskPerTradePercent: f.riskPerTradePercent,
        maxOpenTradesTotal: f.maxOpenTradesTotal, maxTradesPerSymbol: f.maxTradesPerSymbol,
        stopBasis: f.stopBasis, takeProfitPoints: f.takeProfitPoints, stopLossPoints: f.stopLossPoints, profitTargetMoney: f.profitTargetMoney,
        targetProfitMoney: f.targetProfitMoney, maxLossMoney: f.maxLossMoney, maxLotSize: f.maxLotSize, maxTradesPerDay: f.maxTradesPerDay,
        maxConsecutiveLosses: f.maxConsecutiveLosses, pauseAfterLossStreakMinutes: f.pauseAfterLossStreakMinutes,
        dailyLossLimitPercent: f.dailyLossLimitPercent, maxSharedCurrencyExposure: f.maxSharedCurrencyExposure,
      })}>Save risk settings</button>
    </div>
  );
}

function ExecutionForm({ risk, onSave }: { risk: ScalpRisk; onSave: (p: Partial<ScalpRisk>) => void }) {
  const [f, setF] = useServerForm(risk);
  return (
    <div className="card">
      <div className="mb-3 text-sm font-semibold">Execution settings</div>
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Re-entry after win (s)" value={f.reentryAfterWinSeconds} min={1} onChange={(v) => setF({ ...f, reentryAfterWinSeconds: v })} />
        <NumberField label="Re-entry after loss (s)" value={f.reentryAfterLossSeconds} min={1} onChange={(v) => setF({ ...f, reentryAfterLossSeconds: v })} />
      </div>
      <label className="mt-3 block">
        <span className="label">Allowed sessions (comma-separated)</span>
        <input className="input" defaultValue={f.allowedSessions.join(", ")} onBlur={(e) => setF({ ...f, allowedSessions: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </label>
      <div className="mt-3 flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.pauseDuringNews} onChange={(e) => setF({ ...f, pauseDuringNews: e.target.checked })} /> Pause during news</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.flattenBeforeHighImpactNews} onChange={(e) => setF({ ...f, flattenBeforeHighImpactNews: e.target.checked })} /> Flatten before high-impact news</label>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <NumberField label="Pause before news (min)" value={f.pauseBeforeNewsMin} min={0} onChange={(v) => setF({ ...f, pauseBeforeNewsMin: v })} />
        <NumberField label="Pause after news (min)" value={f.pauseAfterNewsMin} min={0} onChange={(v) => setF({ ...f, pauseAfterNewsMin: v })} />
      </div>
      <label className="mt-3 block">
        <span className="label">News risk limit</span>
        <select className="input" value={f.newsRiskLimit} onChange={(e) => setF({ ...f, newsRiskLimit: e.target.value as "LOW" | "MEDIUM" | "HIGH" })}>
          <option value="HIGH">Pause high-impact only</option>
          <option value="MEDIUM">Pause high, reduce medium</option>
          <option value="LOW">Pause medium/high</option>
        </select>
      </label>
      <button className="btn-primary mt-3" onClick={() => onSave({
        reentryAfterWinSeconds: f.reentryAfterWinSeconds, reentryAfterLossSeconds: f.reentryAfterLossSeconds,
        allowedSessions: f.allowedSessions, pauseDuringNews: f.pauseDuringNews, pauseBeforeNewsMin: f.pauseBeforeNewsMin,
        pauseAfterNewsMin: f.pauseAfterNewsMin, newsRiskLimit: f.newsRiskLimit, flattenBeforeHighImpactNews: f.flattenBeforeHighImpactNews,
      })}>Save execution settings</button>
    </div>
  );
}

function ScalpPerformance() {
  const [p, setP] = useState<Record<string, number | null> | null>(null);
  useEffect(() => {
    const load = () => api<Record<string, number | null>>("/api/scalping/performance").then(setP).catch(() => setP(null));
    void load(); const t = setInterval(load, 5000); return () => clearInterval(t);
  }, []);
  if (!p) return null;
  const cells: [string, string][] = [
    ["Closed", String(p.totalClosed ?? 0)],
    ["Wins / Losses", `${p.wins ?? 0} / ${p.losses ?? 0}`],
    ["Win rate", `${Math.round((Number(p.winRate) || 0) * 100)}%`],
    ["Net P/L", fmt(Number(p.netProfit) || 0)],
    ["Profit factor", p.profitFactor == null ? "—" : fmt(Number(p.profitFactor))],
    ["Avg win / loss", `${fmt(Number(p.avgWin) || 0)} / ${fmt(Number(p.avgLoss) || 0)}`],
    ["Today net", fmt(Number(p.todayNet) || 0)],
    ["Open now", String(p.openCount ?? 0)],
  ];
  return (
    <Section title="Scalping performance">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cells.map(([k, v]) => (
          <div key={k} className="rounded-lg bg-surface-2 p-3">
            <div className="text-[11px] text-ink-faint">{k}</div>
            <div className="tnum text-base font-semibold">{v}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}
