"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { IconActivity, IconBell, IconCheck, IconInfo, IconX } from "@/components/icons";

export type ToastTone = "info" | "success" | "warning" | "error" | "activity";
export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
  durationMs?: number;
}
export type ToastReporter = (message: string, tone?: ToastTone) => void;

interface ToastItem extends ToastInput {
  id: string;
  createdAt: number;
}

interface ToastApi {
  show: (input: ToastInput) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  warning: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const DEFAULT_DURATION_MS = 6500;
const MAX_TOASTS = 5;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const dismissAll = useCallback(() => setItems([]), []);

  const show = useCallback((input: ToastInput) => {
    const now = Date.now();
    const id = `${now}-${Math.random().toString(36).slice(2)}`;
    setItems((current) => {
      const duplicate = current.find((item) =>
        item.title === input.title && item.description === input.description && now - item.createdAt < 1500,
      );
      if (duplicate) return current;
      return [{ ...input, tone: input.tone ?? "info", id, createdAt: now }, ...current].slice(0, MAX_TOASTS);
    });
    return id;
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setItems((current) => current.filter((item) => now - item.createdAt < (item.durationMs ?? DEFAULT_DURATION_MS)));
    }, 500);
    return () => window.clearInterval(timer);
  }, [items.length]);

  const value = useMemo<ToastApi>(() => ({
    show,
    success: (title, description) => show({ tone: "success", title, description }),
    error: (title, description) => show({ tone: "error", title, description, durationMs: 9000 }),
    warning: (title, description) => show({ tone: "warning", title, description }),
    info: (title, description) => show({ tone: "info", title, description }),
    dismiss,
    dismissAll,
  }), [dismiss, dismissAll, show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} onDismissAll={dismissAll} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
}

const STYLES: Record<ToastTone, { shell: string; icon: string; badge: string }> = {
  info: { shell: "border-sky-900/70 bg-sky-950/95 text-sky-100", icon: "bg-sky-900 text-sky-200", badge: "text-sky-300" },
  success: { shell: "border-emerald-900/70 bg-emerald-950/95 text-emerald-100", icon: "bg-emerald-900 text-emerald-200", badge: "text-emerald-300" },
  warning: { shell: "border-amber-900/70 bg-amber-950/95 text-amber-100", icon: "bg-amber-900 text-amber-200", badge: "text-amber-300" },
  error: { shell: "border-red-900/70 bg-red-950/95 text-red-100", icon: "bg-red-900 text-red-200", badge: "text-red-300" },
  activity: { shell: "border-line-strong bg-surface/95 text-ink", icon: "bg-surface-3 text-primary", badge: "text-primary" },
};

const LABELS: Record<ToastTone, string> = {
  info: "Information", success: "Success", warning: "Attention", error: "Error", activity: "Activity",
};

function ToastViewport({ items, onDismiss, onDismissAll }: { items: ToastItem[]; onDismiss: (id: string) => void; onDismissAll: () => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Notifications"
      className="group pointer-events-none fixed right-3 top-20 z-[70] w-[min(24rem,calc(100vw-1.5rem))] sm:right-5"
    >
      {items.length > 1 && (
        <div className="pointer-events-auto mb-2 flex items-center justify-end gap-2 px-1 opacity-90">
          <span className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-dim shadow-lg">
            {items.length} notifications
          </span>
          <button type="button" onClick={onDismissAll} className="text-[11px] text-ink-faint hover:text-ink">Clear all</button>
        </div>
      )}
      <div className="flex flex-col [&>*+*]:-mt-11 hover:[&>*+*]:mt-2 focus-within:[&>*+*]:mt-2">
        {items.map((item, index) => {
          const tone = item.tone ?? "info";
          const style = STYLES[tone];
          const Icon = tone === "activity" ? IconActivity : tone === "success" ? IconCheck : tone === "error" ? IconX : tone === "info" ? IconInfo : IconBell;
          return (
            <article
              key={item.id}
              role={tone === "error" ? "alert" : "status"}
              aria-live={tone === "error" ? "assertive" : "polite"}
              style={{ zIndex: items.length - index }}
              className={`pointer-events-auto cursor-pointer rounded-xl border px-3 py-3 shadow-2xl shadow-black/45 backdrop-blur transition-all duration-200 ${style.shell}`}
              onClick={() => setExpandedId((current) => current === item.id ? null : item.id)}
              title="Click to view full details"
            >
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.icon}`}><Icon size={15} /></span>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <span className={`text-[10px] font-semibold uppercase tracking-wide ${style.badge}`}>{LABELS[tone]}</span>
                    <span className="tnum shrink-0 text-[10px] opacity-60">{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <p className="break-words text-sm font-semibold leading-snug">{item.title}</p>
                  {item.description && <p className={`mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed opacity-80 ${expandedId === item.id ? "" : "line-clamp-3"}`}>{item.description}</p>}
                  {item.description && <span className="mt-1.5 block text-[10px] font-medium opacity-65">{expandedId === item.id ? "Click to collapse" : "Click for full reason and action"}</span>}
                </div>
                <button type="button" onClick={(event) => { event.stopPropagation(); onDismiss(item.id); }} aria-label={`Dismiss ${item.title}`} className="shrink-0 rounded-md p-1 opacity-65 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent">
                  <IconX size={14} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
