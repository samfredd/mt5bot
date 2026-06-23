"use client";
import Link from "next/link";
import {
  IconActivity, IconChart, IconCopy, IconFlask, IconHome, IconNews, IconSettings,
  IconStrategy, IconTrades, IconShield, IconZap, IconBrain,
} from "@/components/icons";

/**
 * Single source of truth for the primary navigation. The dashboard renders
 * these as in-page tabs (stateful); standalone pages (e.g. /scalping) render the
 * shared {@link Sidebar}/{@link MobileNav} below, where each item is a real link
 * to `/dashboard?tab=<id>` (the dashboard reads `?tab=` on mount).
 */
export const NAV = [
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

/** Marks the dedicated Scalping page as active in the shared sidebar. */
export const SCALPING_NAV_ID = "Scalping Mode";

function Brand() {
  return (
    <div className="mb-8 flex items-center gap-2.5 px-2 pt-1">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-dim text-white">
        <IconZap size={18} />
      </span>
      <div>
        <div className="text-sm font-semibold leading-tight">MT5 AI Bot</div>
        <div className="text-[11px] text-ink-faint">Trading platform</div>
      </div>
    </div>
  );
}

/** Desktop sidebar for standalone (non-dashboard) pages. */
export function Sidebar({ active, footer }: { active: string; footer?: React.ReactNode }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface/60 p-4 lg:flex">
      <Brand />
      <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
        {NAV.map(({ id, label, icon: I }) => (
          <Link key={id} href={`/dashboard?tab=${encodeURIComponent(id)}`} aria-current={active === id ? "page" : undefined}
            className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors duration-200 ${
              active === id ? "bg-surface-3 font-medium text-ink" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
            }`}>
            <I size={17} className={active === id ? "text-primary" : ""} />
            {label}
          </Link>
        ))}
        <Link href="/scalping" aria-current={active === SCALPING_NAV_ID ? "page" : undefined}
          className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors duration-200 ${
            active === SCALPING_NAV_ID ? "bg-surface-3 font-medium text-ink" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
          }`}>
          <IconZap size={17} className={active === SCALPING_NAV_ID ? "text-primary" : ""} />
          Scalping Mode
        </Link>
      </nav>
      {footer}
    </aside>
  );
}

/** Mobile top nav for standalone pages. */
export function MobileNav({ active }: { active: string }) {
  return (
    <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden" aria-label="Main">
      {NAV.map(({ id, label, icon: I }) => (
        <Link key={id} href={`/dashboard?tab=${encodeURIComponent(id)}`}
          className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors ${
            active === id ? "bg-surface-3 font-medium text-ink" : "text-ink-dim"
          }`}>
          <I size={14} className={active === id ? "text-primary" : ""} />
          {label}
        </Link>
      ))}
      <Link href="/scalping"
        className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors ${
          active === SCALPING_NAV_ID ? "bg-surface-3 font-medium text-ink" : "text-ink-dim"
        }`}>
        <IconZap size={14} className={active === SCALPING_NAV_ID ? "text-primary" : ""} />
        Scalping Mode
      </Link>
    </nav>
  );
}
