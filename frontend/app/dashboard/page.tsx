"use client";
import { useCallback, useEffect, useState } from "react";
import { api, WS_URL } from "@/lib/api";
import { Controls } from "@/components/Controls";
import { TradesPanel } from "@/components/TradesPanel";
import { StrategiesPanel } from "@/components/StrategiesPanel";
import { CopyPanel } from "@/components/CopyPanel";
import { NewsPanel } from "@/components/NewsPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PerformancePanel } from "@/components/PerformancePanel";
import { ActivityPanel } from "@/components/ActivityPanel";
import { NotificationsBell } from "@/components/NotificationsBell";
import {
  IconActivity, IconChart, IconCopy, IconHome, IconNews, IconSettings,
  IconStrategy, IconTrades, IconUp, IconDown, IconWallet, IconShield, IconZap, IconX,
} from "@/components/icons";

export interface Overview {
  account: { balance: number; equity: number; margin: number; free_margin: number; margin_level: number; currency: string; is_demo: boolean };
  botState: { status: string; mode: string; emergencyStop: boolean; demoMode: boolean; liveTradingEnabled: boolean };
  openTrades: { ticket: string; symbol: string; type: string; volume: number; price_open: number; sl: number | null; tp: number | null; profit: number }[];
  floatingPnl: number;
  dailyPnl: number;
  pendingApprovals: number;
  activeStrategies: { id: string; name: string }[];
  activeCopyTraders: number;
}

const NAV = [
  { id: "Overview", label: "Overview", icon: IconHome },
  { id: "Trades", label: "Trades", icon: IconTrades },
  { id: "Activity", label: "Activity", icon: IconActivity },
  { id: "Performance", label: "Performance", icon: IconChart },
  { id: "Strategies", label: "Strategies", icon: IconStrategy },
  { id: "Copy Trading", label: "Copy Trading", icon: IconCopy },
  { id: "News", label: "News", icon: IconNews },
  { id: "Settings", label: "Settings", icon: IconSettings },
] as const;

type TabId = (typeof NAV)[number]["id"];

export default function Dashboard() {
  const [tab, setTab] = useState<TabId>("Overview");
  const [data, setData] = useState<Overview | null>(null);
  const [toast, setToast] = useState("");
  const [notifTick, setNotifTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setData(await api<Overview>("/api/overview"));
    } catch { /* backend may be starting */ }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 5000);
    const ws = new WebSocket(WS_URL);
    ws.onmessage = (msg) => {
      try {
        const { event, data: d } = JSON.parse(msg.data);
        if (event === "notification") {
          setToast(`${d.title} — ${d.body}`.slice(0, 180));
          setNotifTick((n) => n + 1);
        }
        if (event === "trade" || event === "approval_request" || event === "emergency_stop") void refresh();
      } catch { /* ignore */ }
    };
    return () => { clearInterval(interval); ws.close(); };
  }, [refresh]);

  // Auto-dismiss toast after 5s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const s = data?.botState;

  return (
    <div className="flex min-h-dvh">
      {/* Sidebar — desktop */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface/60 p-4 lg:flex">
        <div className="mb-8 flex items-center gap-2.5 px-2 pt-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-dim text-white">
            <IconZap size={18} />
          </span>
          <div>
            <div className="text-sm font-semibold leading-tight">MT5 AI Bot</div>
            <div className="text-[11px] text-ink-faint">Trading platform</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
          {NAV.map(({ id, label, icon: I }) => (
            <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}
              className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors duration-200 ${
                tab === id ? "bg-surface-3 font-medium text-ink" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
              }`}>
              <I size={17} className={tab === id ? "text-primary" : ""} />
              {label}
              {id === "Trades" && (data?.pendingApprovals ?? 0) > 0 && (
                <span className="tnum ml-auto rounded-full bg-warn px-2 py-0.5 text-[11px] font-bold text-black">
                  {data?.pendingApprovals}
                </span>
              )}
            </button>
          ))}
        </nav>
        {s && (
          <div className="card mt-4 !p-3 text-xs">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-ink-faint">Status</span>
              <StatusPill status={s.status} emergencyStop={s.emergencyStop} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-faint">Mode</span>
              <span className="font-medium text-ink">{modeLabel(s.mode)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-ink-faint">Account</span>
              <span className={`chip ${s.demoMode ? "bg-emerald-950 text-up" : "bg-red-950 text-down"}`}>
                <IconShield size={11} /> {s.demoMode ? "Demo" : "LIVE"}
              </span>
            </div>
          </div>
        )}
      </aside>

      {/* Main column */}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 md:px-8">
            <div className="flex items-center gap-3 lg:hidden">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-dim text-white"><IconZap size={15} /></span>
              <span className="text-sm font-semibold">MT5 AI Bot</span>
            </div>
            <h1 className="hidden text-lg font-semibold lg:block">{tab}</h1>
            <div className="flex items-center gap-4">
              {data && (
                <div className="text-right">
                  <div className="tnum text-base font-semibold leading-tight">
                    {fmt(data.account.balance)} <span className="text-xs font-normal text-ink-faint">{data.account.currency}</span>
                  </div>
                  <div className={`tnum flex items-center justify-end gap-1 text-xs ${data.floatingPnl >= 0 ? "text-up" : "text-down"}`}>
                    {data.floatingPnl >= 0 ? <IconUp size={12} /> : <IconDown size={12} />}
                    {data.floatingPnl >= 0 ? "+" : ""}{fmt(data.floatingPnl)} floating
                  </div>
                </div>
              )}
              <NotificationsBell liveEvent={notifTick} />
            </div>
          </div>
          {/* Mobile nav */}
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden" aria-label="Main">
            {NAV.map(({ id, label, icon: I }) => (
              <button key={id} onClick={() => setTab(id)}
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors ${
                  tab === id ? "bg-surface-3 font-medium text-ink" : "text-ink-dim"
                }`}>
                <I size={14} className={tab === id ? "text-primary" : ""} />
                {label}
                {id === "Trades" && (data?.pendingApprovals ?? 0) > 0 && (
                  <span className="tnum rounded-full bg-warn px-1.5 text-[10px] font-bold text-black">{data?.pendingApprovals}</span>
                )}
              </button>
            ))}
          </nav>
        </header>

        {toast && (
          <div role="status" aria-live="polite"
            className="mx-auto mt-4 flex max-w-6xl items-start justify-between gap-3 rounded-xl border border-sky-900 bg-sky-950/70 px-4 py-3 text-sm text-sky-100 backdrop-blur md:mx-8">
            <span>{toast}</span>
            <button onClick={() => setToast("")} aria-label="Dismiss notification" className="cursor-pointer text-sky-300 hover:text-white">
              <IconX size={15} />
            </button>
          </div>
        )}

        <main className="mx-auto max-w-6xl px-4 py-6 md:px-8">
          {tab === "Overview" && (
            <div className="space-y-6">
              {data && <OverviewPanel data={data} />}
              <Controls onChanged={refresh} state={s} />
            </div>
          )}
          {tab === "Trades" && <TradesPanel openTrades={data?.openTrades ?? []} onChanged={refresh} />}
          {tab === "Activity" && <ActivityPanel />}
          {tab === "Performance" && <PerformancePanel />}
          {tab === "Strategies" && <StrategiesPanel />}
          {tab === "Copy Trading" && <CopyPanel />}
          {tab === "News" && <NewsPanel />}
          {tab === "Settings" && <SettingsPanel />}
        </main>
      </div>
    </div>
  );
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function modeLabel(mode: string) {
  return { MANUAL: "Manual", SEMI_AUTO: "Semi-auto", AUTO: "Automatic", COPY: "Copy" }[mode] ?? mode;
}

function StatusPill({ status, emergencyStop }: { status: string; emergencyStop: boolean }) {
  const cfg = emergencyStop || status === "emergency_stop"
    ? { dot: "bg-down", text: "text-down", label: "Emergency stop" }
    : status === "running"
      ? { dot: "bg-up", text: "text-up", label: "Running" }
      : status === "paused"
        ? { dot: "bg-warn", text: "text-warn", label: "Paused" }
        : { dot: "bg-ink-faint", text: "text-ink-dim", label: "Stopped" };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.text}`}>
      <span className={`h-2 w-2 rounded-full ${cfg.dot} ${status === "running" ? "animate-pulse" : ""}`} />
      {cfg.label}
    </span>
  );
}

function OverviewPanel({ data }: { data: Overview }) {
  const a = data.account;
  const stats: { label: string; value: string; sub?: string; tone?: "up" | "down" }[] = [
    { label: "Balance", value: `${fmt(a.balance)} ${a.currency}` },
    { label: "Equity", value: fmt(a.equity) },
    { label: "Free margin", value: fmt(a.free_margin) },
    { label: "Margin level", value: a.margin_level > 0 ? `${a.margin_level.toFixed(0)}%` : "—" },
    {
      label: "Daily P/L", value: `${data.dailyPnl >= 0 ? "+" : ""}${fmt(data.dailyPnl)}`,
      tone: data.dailyPnl >= 0 ? "up" : "down",
    },
    {
      label: "Floating P/L", value: `${data.floatingPnl >= 0 ? "+" : ""}${fmt(data.floatingPnl)}`,
      sub: `${data.openTrades.length} open trade${data.openTrades.length === 1 ? "" : "s"}`,
      tone: data.floatingPnl >= 0 ? "up" : "down",
    },
    {
      label: "Strategies", value: String(data.activeStrategies.length),
      sub: data.activeStrategies.map((x) => x.name).join(", ") || "none active",
    },
    { label: "Pending approvals", value: String(data.pendingApprovals), sub: data.activeCopyTraders ? `${data.activeCopyTraders} copy trader(s)` : undefined },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="card card-hover">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-ink-faint">
            {stat.label === "Balance" && <IconWallet size={13} />}
            {stat.label}
          </div>
          <div className={`tnum truncate text-xl font-semibold ${stat.tone === "up" ? "text-up" : stat.tone === "down" ? "text-down" : "text-ink"}`}>
            {stat.value}
          </div>
          {stat.sub && <div className="mt-1 truncate text-xs text-ink-faint">{stat.sub}</div>}
        </div>
      ))}
    </div>
  );
}
