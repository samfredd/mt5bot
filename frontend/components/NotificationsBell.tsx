"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { IconBell, IconCheck, IconX } from "@/components/icons";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  channel: string;
  createdAt: string;
  status?: string;
  actions?: NotificationAction[];
}

interface NotificationAction { label: string; href: string; }

const LAST_SEEN_KEY = "mt5bot_notifications_seen";

export function NotificationsBell({ liveEvent }: { liveEvent: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<Notification | null>(null);
  const [lastSeen, setLastSeen] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem(LAST_SEEN_KEY) ?? new Date(0).toISOString() : new Date(0).toISOString(),
  );

  const load = useCallback(async () => {
    try {
      setLoadError(false);
      const rows = await api<Notification[]>("/api/notifications");
      setItems(rows.filter((notification) => notification.channel === "WEB"));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, liveEvent]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const unread = items.filter((notification) => notification.createdAt > lastSeen).length;
  const visibleItems = useMemo(
    () => (unreadOnly ? items.filter((notification) => notification.createdAt > lastSeen) : items).slice(0, 50),
    [items, lastSeen, unreadOnly],
  );

  function markAllRead() {
    const now = new Date().toISOString();
    localStorage.setItem(LAST_SEEN_KEY, now);
    setLastSeen(now);
  }

  function toggle() {
    setOpen((current) => !current);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        className="btn-ghost relative !p-2.5"
      >
        <IconBell size={17} />
        {unread > 0 && (
          <span className="tnum absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-down px-1 text-[11px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close notifications" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <section role="dialog" aria-label="Notification center" className="absolute right-0 z-50 mt-2 flex max-h-[min(34rem,calc(100dvh-6rem))] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/60">
            <header className="border-b border-line px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-ink">Notifications</h2>
                  <p className="mt-0.5 text-xs text-ink-faint">{unread ? `${unread} unread update${unread === 1 ? "" : "s"}` : "You are all caught up"}</p>
                </div>
                <div className="flex items-center gap-1">
                  {unread > 0 && <button type="button" onClick={markAllRead} className="btn-ghost btn-sm" title="Mark all as read"><IconCheck size={13} /> Read all</button>}
                  <button type="button" onClick={() => setOpen(false)} aria-label="Close notification center" className="btn-ghost !p-2"><IconX size={14} /></button>
                </div>
              </div>
              <div className="mt-3 flex rounded-lg bg-bg p-1" role="group" aria-label="Notification filter">
                <button type="button" onClick={() => setUnreadOnly(false)} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${!unreadOnly ? "bg-surface-3 text-ink" : "text-ink-faint hover:text-ink"}`}>All</button>
                <button type="button" onClick={() => setUnreadOnly(true)} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${unreadOnly ? "bg-surface-3 text-ink" : "text-ink-faint hover:text-ink"}`}>Unread {unread > 0 && `(${unread})`}</button>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading && <p className="px-3 py-8 text-center text-sm text-ink-faint">Loading notifications…</p>}
              {!loading && loadError && (
                <div className="px-3 py-8 text-center"><p className="text-sm text-down">Notifications could not be loaded.</p><button type="button" onClick={() => void load()} className="btn-ghost btn-sm mt-3">Try again</button></div>
              )}
              {!loading && !loadError && visibleItems.length === 0 && <p className="px-3 py-8 text-center text-sm text-ink-faint">{unreadOnly ? "No unread notifications." : "Nothing yet."}</p>}
              {visibleItems.map((notification) => {
                const isUnread = notification.createdAt > lastSeen;
                return (
                  <button type="button" key={notification.id} onClick={() => setSelected(notification)} className={`mb-1 w-full rounded-xl border p-3 text-left transition hover:border-primary/40 hover:bg-surface-3 ${isUnread ? "border-primary/30 bg-primary-dim/10" : "border-transparent bg-surface-2"}`} title="View full notification details and actions">
                    <div className="flex items-start gap-2.5">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${notificationDot(notification.type, isUnread)}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-sm font-medium leading-snug text-ink">{notification.title}</h3>
                          <time dateTime={notification.createdAt} className="tnum shrink-0 text-[10px] text-ink-faint">{relativeTime(notification.createdAt)}</time>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-dim">{notification.body.slice(0, 400)}</p>
                        <span className="mt-2 inline-block text-[10px] uppercase tracking-wide text-ink-faint">{notification.type.replace(/_/g, " ")}</span>
                        <span className="ml-2 text-[10px] font-medium text-primary">View details</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
          {selected && (
            <section role="dialog" aria-modal="true" aria-label="Notification details" className="fixed inset-x-3 top-1/2 z-[60] mx-auto max-h-[80dvh] w-auto max-w-xl -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-surface p-5 text-left shadow-2xl shadow-black/70">
              <div className="flex items-start justify-between gap-4">
                <div><p className="eyebrow">{selected.type.replace(/_/g, " ")}</p><h2 className="mt-1 text-lg font-semibold text-ink">{selected.title}</h2></div>
                <button type="button" onClick={() => setSelected(null)} aria-label="Close notification details" className="btn-ghost !p-2"><IconX size={15} /></button>
              </div>
              <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-dim">{selected.body}</p>
              <dl className="mt-5 grid gap-2 rounded-xl bg-surface-2 p-3 text-xs sm:grid-cols-2">
                <div><dt className="text-ink-faint">Time</dt><dd className="mt-0.5 text-ink">{new Date(selected.createdAt).toLocaleString()}</dd></div>
                <div><dt className="text-ink-faint">Delivery</dt><dd className="mt-0.5 text-ink">{selected.channel}{selected.status ? ` · ${selected.status}` : ""}</dd></div>
                <div className="sm:col-span-2"><dt className="text-ink-faint">Reference</dt><dd className="mt-0.5 break-all font-mono text-ink">{selected.id}</dd></div>
              </dl>
              <div className="mt-5 flex flex-wrap gap-2">
                {(selected.actions?.length ? selected.actions : notificationActions(selected.type)).map((action) => <a key={`${action.href}:${action.label}`} href={action.href} className="btn-ghost">{action.label}</a>)}
                <button type="button" onClick={() => setSelected(null)} className="btn-primary">Done</button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function notificationActions(type: string): NotificationAction[] {
  if (/approval/.test(type)) return [{ label: "Review trade", href: "/dashboard?tab=Trades" }, { label: "Open settings", href: "/dashboard?tab=Settings" }];
  if (/trade|profit|loss|stop/.test(type)) return [{ label: "View trades", href: "/dashboard?tab=Trades" }, { label: "View activity", href: "/dashboard?tab=Activity" }];
  if (/news/.test(type)) return [{ label: "Open news", href: "/dashboard?tab=News" }, { label: "Review settings", href: "/dashboard?tab=Settings" }];
  if (/error|risk|emergency|paused/.test(type)) return [{ label: "View incidents", href: "/dashboard?tab=Activity" }, { label: "Review settings", href: "/dashboard?tab=Settings" }];
  return [{ label: "View activity", href: "/dashboard?tab=Activity" }];
}

function notificationDot(type: string, unread: boolean): string {
  if (!unread) return "bg-ink-faint";
  if (/error|emergency|risk|loss|stop/.test(type)) return "bg-down";
  if (/opened|closed|resumed|profit|report/.test(type)) return "bg-up";
  if (/warning|news|approval|paused/.test(type)) return "bg-warn";
  return "bg-accent";
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
}
