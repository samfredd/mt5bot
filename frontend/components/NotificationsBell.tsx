"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconBell } from "@/components/icons";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  channel: string;
  createdAt: string;
}

const LAST_SEEN_KEY = "mt5bot_notifications_seen";

export function NotificationsBell({ liveEvent }: { liveEvent: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [lastSeen, setLastSeen] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem(LAST_SEEN_KEY) ?? new Date(0).toISOString() : new Date(0).toISOString(),
  );

  const load = useCallback(async () => {
    try {
      const rows = await api<Notification[]>("/api/notifications");
      setItems(rows.filter((n) => n.channel === "WEB"));
    } catch { /* noop */ }
  }, []);

  useEffect(() => { void load(); }, [load, liveEvent]);

  const unread = items.filter((n) => n.createdAt > lastSeen).length;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      const now = new Date().toISOString();
      localStorage.setItem(LAST_SEEN_KEY, now);
      setLastSeen(now);
    }
  }

  return (
    <div className="relative">
      <button onClick={toggle} aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        className="btn-ghost relative !p-2.5">
        <IconBell size={17} />
        {unread > 0 && (
          <span className="tnum absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-down px-1 text-[11px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 max-h-[28rem] w-[22rem] overflow-auto rounded-2xl border border-line bg-surface p-2 shadow-2xl shadow-black/50 sm:w-96">
            <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Notifications</div>
            {items.length === 0 && <p className="px-2 py-4 text-center text-sm text-ink-faint">Nothing yet.</p>}
            {items.slice(0, 30).map((n) => (
              <div key={n.id} className={`mb-1 rounded-xl p-3 text-sm ${n.createdAt > lastSeen ? "bg-surface-3" : "bg-surface-2"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{n.title}</span>
                  <span className="tnum shrink-0 text-[10px] text-ink-faint">{new Date(n.createdAt).toLocaleTimeString()}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-dim">{n.body.slice(0, 300)}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
