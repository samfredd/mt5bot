"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, logout, WS_URL } from "@/lib/api";
import { Controls } from "@/components/Controls";
import { TradesPanel } from "@/components/TradesPanel";
import { StrategiesPanel } from "@/components/StrategiesPanel";
import { CopyPanel } from "@/components/CopyPanel";
import { NewsPanel } from "@/components/NewsPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PerformancePanel } from "@/components/PerformancePanel";
import { ActivityPanel } from "@/components/ActivityPanel";
import { BacktestPanel } from "@/components/BacktestPanel";
import { StrategyLabPanel } from "@/components/StrategyLabPanel";
import { NotificationsBell } from "@/components/NotificationsBell";
import { IncidentCenter } from "@/components/IncidentCenter";
import { ValidationEvidencePanel } from "@/components/ValidationEvidencePanel";
import { PaperForwardPanel } from "@/components/PaperForwardPanel";
import { ExposurePanel } from "@/components/ExposurePanel";
import { ExecutionComparisonPanel } from "@/components/ExecutionComparisonPanel";
import { TradeJournalPanel } from "@/components/TradeJournalPanel";
import {
  IconActivity, IconChart, IconCopy, IconFlask, IconHome, IconNews, IconSettings,
  IconStrategy, IconTrades, IconUp, IconDown, IconWallet, IconShield, IconZap, IconX, IconBrain, IconBell,
} from "@/components/icons";

export interface Overview {
  account: { balance: number; equity: number; margin: number; free_margin: number; margin_level: number; currency: string; is_demo: boolean };
  botState: { status: string; mode: string; emergencyStop: boolean; demoMode: boolean; liveTradingEnabled: boolean; paperForward: boolean };
  openTrades: { ticket: string; symbol: string; type: string; volume: number; price_open: number; price_current?: number; sl: number | null; tp: number | null; profit: number; time?: string }[];
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
  { id: "Backtest", label: "Backtest", icon: IconFlask },
  { id: "Strategy Lab", label: "Strategy Lab", icon: IconBrain },
  { id: "Evidence", label: "Evidence", icon: IconShield },
  { id: "Journal", label: "Journal", icon: IconTrades },
  { id: "Strategies", label: "Strategies", icon: IconStrategy },
  { id: "Copy Trading", label: "Copy Trading", icon: IconCopy },
  { id: "News", label: "News", icon: IconNews },
  { id: "Settings", label: "Settings", icon: IconSettings },
] as const;

type TabId = (typeof NAV)[number]["id"];

type ToastTone = "info" | "success" | "warn" | "danger" | "activity";
interface ToastMessage {
  id: string;
  tone: ToastTone;
  label: string;
  title: string;
  body: string;
  createdAt: number;
}

interface LiveNotification {
  type?: string;
  title?: string;
  body?: string;
}

interface LiveAudit {
  actor?: string;
  category?: string;
  action?: string;
  detail?: Record<string, unknown> | null;
  createdAt?: string;
}

const TOAST_TTL_MS = 7000;
const MAX_TOASTS = 6;

export default function Dashboard() {
  const [tab, setTab] = useState<TabId>("Overview");
  const [data, setData] = useState<Overview | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [notifTick, setNotifTick] = useState(0);
  const [evidenceTick, setEvidenceTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setData(await api<Overview>("/api/overview"));
    } catch { /* backend may be starting */ }
  }, []);

  const pushToast = useCallback((toast: Omit<ToastMessage, "id" | "createdAt">) => {
    const stamp = Date.now();
    const id = `${stamp}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [{ ...toast, id, createdAt: stamp }, ...prev].slice(0, MAX_TOASTS));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // Deep-link support: /dashboard?tab=Trades opens that tab. Used by the shared
  // Sidebar on standalone pages (e.g. /scalping) so its nav lands correctly.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested && NAV.some((n) => n.id === requested)) setTab(requested as TabId);
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 5000);

    // Live push updates with auto-reconnect: the backend restarts (dev) or the
    // socket can drop, and without reconnecting the dashboard would silently
    // stop updating until a manual refresh.
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(WS_URL);
      ws.onmessage = (msg) => {
        try {
          const { event, data: d } = JSON.parse(msg.data);
          if (event === "notification") {
            const notification = d as LiveNotification;
            pushToast({
              tone: notificationTone(notification.type),
              label: "Notification",
              title: notification.title ?? "Notification",
              body: notification.body ?? "",
            });
            setNotifTick((n) => n + 1);
          }
          if (event === "audit") pushToast(activityToast(d as LiveAudit));
          if (event === "incident") setEvidenceTick((value) => value + 1);
          // Reflect bot state instantly (start/pause/mode/guardian/emergency).
          if (event === "bot_state") setData((prev) => (prev ? { ...prev, botState: { ...prev.botState, ...d } } : prev));
          if (event === "floating_pnl") {
            setData((prev) => prev ? {
              ...prev,
              floatingPnl: d.floatingPnl,
              openTrades: prev.openTrades.map((position) => {
                const live = d.positions?.find((item: { ticket: string }) => item.ticket === position.ticket);
                return live ? { ...position, profit: live.profit } : position;
              }),
            } : prev);
          }
          if (event === "trade" || event === "approval_request" || event === "emergency_stop" || event === "scanner") void refresh();
        } catch { /* ignore */ }
      };
      ws.onclose = () => { if (!stopped) retry = setTimeout(connect, 2000); };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      stopped = true;
      clearInterval(interval);
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [pushToast, refresh]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((toast) => now - toast.createdAt < TOAST_TTL_MS));
    }, 1000);
    return () => clearInterval(timer);
  }, [toasts.length]);

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
          {/* Scalping Mode is a separate page (its own engine), not a dashboard tab. */}
          <Link href="/scalping"
            className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-dim transition-colors duration-200 hover:bg-surface-2 hover:text-ink">
            <IconZap size={17} /> Scalping Mode
          </Link>
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
              {/* Truth comes from the broker, not a local flag */}
              <span className={`chip ${data?.account.is_demo !== false ? "bg-emerald-950 text-up" : "bg-red-950 text-down"}`}>
                <IconShield size={11} /> {data?.account.is_demo !== false ? "Demo" : "REAL"}
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
              <HealthBadge />
              <NotificationsBell liveEvent={notifTick} />
              <button onClick={() => void logout()} title="Sign out"
                className="btn-ghost !px-3 text-xs text-ink-dim hover:text-ink">
                Sign out
              </button>
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
            <Link href="/scalping" className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-ink-dim">
              <IconZap size={14} /> Scalping Mode
            </Link>
          </nav>
        </header>

        <ToastStack toasts={toasts} onDismiss={dismissToast} />

        <main className="mx-auto max-w-6xl px-4 py-6 md:px-8">
          {tab === "Overview" && (
            <div className="space-y-6">
              {data && <OverviewPanel data={data} />}
              <Controls onChanged={refresh} state={s} />
              <ActivityPanel />
            </div>
          )}
          {tab === "Trades" && <TradesPanel openTrades={data?.openTrades ?? []} onChanged={refresh} />}
          {tab === "Activity" && <ActivityPanel />}
          {tab === "Performance" && <PerformancePanel />}
          {tab === "Backtest" && <BacktestPanel />}
          {tab === "Strategy Lab" && <StrategyLabPanel />}
          {tab === "Evidence" && <div className="space-y-4"><IncidentCenter refreshKey={evidenceTick} /><ValidationEvidencePanel /><PaperForwardPanel /><ExposurePanel /><ExecutionComparisonPanel /></div>}
          {tab === "Journal" && <TradeJournalPanel />}
          {tab === "Strategies" && <StrategiesPanel />}
          {tab === "Copy Trading" && <CopyPanel />}
          {tab === "News" && <NewsPanel />}
          {tab === "Settings" && <SettingsPanel />}
        </main>
      </div>
    </div>
  );
}

const TOAST_STYLES: Record<ToastTone, { shell: string; icon: string; badge: string }> = {
  info: {
    shell: "border-sky-900/70 bg-sky-950/90 text-sky-100",
    icon: "bg-sky-900 text-sky-200",
    badge: "text-sky-300",
  },
  success: {
    shell: "border-emerald-900/70 bg-emerald-950/90 text-emerald-100",
    icon: "bg-emerald-900 text-emerald-200",
    badge: "text-emerald-300",
  },
  warn: {
    shell: "border-amber-900/70 bg-amber-950/90 text-amber-100",
    icon: "bg-amber-900 text-amber-200",
    badge: "text-amber-300",
  },
  danger: {
    shell: "border-red-900/70 bg-red-950/90 text-red-100",
    icon: "bg-red-900 text-red-200",
    badge: "text-red-300",
  },
  activity: {
    shell: "border-line-strong bg-surface/95 text-ink",
    icon: "bg-surface-3 text-primary",
    badge: "text-primary",
  },
};

function ToastStack({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-3 top-20 z-50 flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2 sm:right-5"
    >
      {toasts.map((toast) => {
        const style = TOAST_STYLES[toast.tone];
        const Icon = toast.label === "Activity" ? IconActivity : IconBell;
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-xl border px-3 py-3 shadow-2xl shadow-black/40 backdrop-blur ${style.shell}`}
          >
            <div className="flex items-start gap-3">
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.icon}`}>
                <Icon size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-semibold uppercase ${style.badge}`}>{toast.label}</span>
                  <span className="tnum shrink-0 text-[10px] opacity-65">{new Date(toast.createdAt).toLocaleTimeString()}</span>
                </div>
                <p className="break-words text-sm font-semibold leading-snug">{toast.title}</p>
                {toast.body && <p className="mt-1 line-clamp-3 break-words text-xs leading-relaxed opacity-80">{toast.body}</p>}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                aria-label="Dismiss toast"
                className="shrink-0 cursor-pointer rounded-md p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <IconX size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function notificationTone(type?: string): ToastTone {
  if (!type) return "info";
  if (["emergency_stop", "risk_violation", "system_error", "margin_warning", "drawdown_warning", "daily_loss_warning", "stop_loss_hit"].includes(type)) return "danger";
  if (["approval_request", "ai_avoid", "news_alert", "bot_paused"].includes(type)) return "warn";
  if (["trade_opened", "trade_closed", "take_profit_hit", "bot_resumed", "copy_update", "daily_report"].includes(type)) return "success";
  return "info";
}

function activityToast(activity: LiveAudit): Omit<ToastMessage, "id" | "createdAt"> {
  const category = activity.category ?? "activity";
  const action = humanize(activity.action ?? "event");
  const summary = summarizeActivity(activity);
  return {
    tone: activityTone(activity),
    label: "Activity",
    title: `${capitalize(category)} - ${action}`,
    body: summary || "New activity event received.",
  };
}

function activityTone(activity: LiveAudit): ToastTone {
  const category = activity.category ?? "";
  const action = activity.action ?? "";
  if (category === "risk" || action.includes("failed") || action.includes("blocked") || action.includes("emergency")) return "danger";
  if (action.includes("executed") || action.includes("approved") || action.includes("opened") || action.includes("resumed")) return "success";
  if (category === "news" || category === "ai" || action.includes("veto") || action.includes("paused")) return "warn";
  return "activity";
}

function summarizeActivity(activity: LiveAudit): string {
  const detail = activity.detail ?? {};
  const bits: string[] = [];
  const symbol = stringValue(detail.symbol);
  if (symbol) bits.push(symbol);
  if (typeof detail.scanned === "number") bits.push(`${detail.scanned} scanned`);
  if (Array.isArray(detail.candidates)) bits.push(`${detail.candidates.length} candidate(s)`);
  if (Array.isArray(detail.failed) && detail.failed.length) bits.push(`failed: ${detail.failed.map(String).join(", ")}`);
  const reason = stringValue(detail.reason) ?? stringValue(detail.reasoning);
  if (reason) bits.push(reason);
  if (typeof detail.confidence === "number") bits.push(`confidence ${Math.round(detail.confidence * 100)}%`);
  if (detail.result && typeof detail.result === "object") {
    const result = detail.result as { ok?: unknown; error?: unknown; retcode?: unknown };
    if (typeof result.ok === "boolean") bits.push(result.ok ? "broker accepted" : "broker rejected");
    if (result.retcode != null) bits.push(`retcode ${String(result.retcode)}`);
    if (typeof result.error === "string") bits.push(result.error);
  }
  if (detail.patch && typeof detail.patch === "object") bits.push(`updated ${Object.keys(detail.patch).join(", ")}`);
  if (activity.actor) bits.push(`actor: ${activity.actor}`);
  return truncate(bits.join(" · "), 220);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Health {
  ok: boolean;
  degraded: string[];
  mt5Bridge: { ok: boolean; mock: boolean; connected: boolean };
  ai: { reachable: boolean; modelPresent: boolean; model: string; provider: "ollama" | "anthropic"; recentValidRate: number | null; recentSamples: number; lastValidAt: string | null };
}

/**
 * Live AI/bridge health. Polls /health so you can SEE when the model is down
 * (Ollama stopped, or the model isn't pulled) — in that state the bot vetoes
 * every trade, so this turning red explains "why no trades".
 */
function HealthBadge() {
  const [h, setH] = useState<Health | null>(null);
  useEffect(() => {
    const load = () => api<Health>("/health").then(setH).catch(() => setH(null));
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const ai = h?.ai;
  const aiOk = !!ai && ai.reachable && ai.modelPresent;
  const title = !h
    ? "Health unknown — backend unreachable"
    : aiOk
      ? `AI online — ${ai!.provider} model ${ai!.model}${ai!.recentValidRate !== null ? ` · ${Math.round(ai!.recentValidRate * 100)}% of last ${ai!.recentSamples} calls valid` : " · no calls yet"}`
      : !ai?.reachable
        ? `AI OFFLINE — ${ai?.provider ?? "selected provider"} unreachable. Trade vetting remains fail-closed.`
        : `AI DEGRADED — configured model "${ai.model}" is unavailable.`;

  return (
    <span title={title} className={`chip ${aiOk ? "bg-emerald-950 text-up" : "bg-red-950 text-down"}`}>
      <span className={`h-2 w-2 rounded-full ${aiOk ? "bg-up animate-pulse" : "bg-down"}`} />
      AI {aiOk ? "online" : !ai?.reachable ? "offline" : "no model"}
    </span>
  );
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
