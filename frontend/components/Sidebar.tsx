"use client";
import { useState } from "react";
import Link from "next/link";
import {
  IconActivity, IconChart, IconCopy, IconFlask, IconHome, IconNews, IconSettings,
  IconStrategy, IconTrades, IconShield, IconZap, IconBrain, IconMessageCircle, IconMore, IconX,
} from "@/components/icons";

/**
 * Single source of truth for the primary navigation. The dashboard renders
 * these as in-page tabs (stateful); standalone pages (e.g. /scalping) render the
 * shared {@link Sidebar}/{@link MobileNav} below, where each item is a real link
 * to `/dashboard?tab=<id>` (the dashboard reads `?tab=` on mount).
 */
export const NAV = [
  { id: "Overview", label: "Overview", icon: IconHome, group: "Workspace" },
  { id: "Trades", label: "Trades", icon: IconTrades, group: "Workspace" },
  { id: "Assistant", label: "Assistant", icon: IconMessageCircle, group: "Workspace" },
  { id: "Strategies", label: "Strategies", icon: IconStrategy, group: "Workspace" },
  { id: "Performance", label: "Performance", icon: IconChart, group: "Workspace" },
  { id: "Activity", label: "Activity", icon: IconActivity, group: "Workspace" },
  { id: "Strategy Lab", label: "Strategy Lab", icon: IconBrain, group: "Tools" },
  { id: "Backtest", label: "Backtest", icon: IconFlask, group: "Tools" },
  { id: "Paper Trades", label: "Paper Trades", icon: IconFlask, group: "Tools" },
  { id: "Copy Trading", label: "Copy Trading", icon: IconCopy, group: "Tools" },
  { id: "Journal", label: "Journal", icon: IconTrades, group: "Tools" },
  { id: "News", label: "News", icon: IconNews, group: "Tools" },
  { id: "Research", label: "Research", icon: IconBrain, group: "Tools" },
  { id: "Evidence", label: "Evidence", icon: IconShield, group: "Tools" },
  { id: "Settings", label: "Settings", icon: IconSettings, group: "System" },
] as const;

export type NavId = (typeof NAV)[number]["id"];

/** Marks the dedicated Scalping page as active in the shared sidebar. */
export const SCALPING_NAV_ID = "Scalping Mode";

function Brand() {
  return (
    <div className="mb-5 flex items-center gap-2.5 px-2 pt-1 xl:mb-8">
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
export function Sidebar({ active, footer, onSelect, pendingApprovals = 0 }: {
  active: string;
  footer?: React.ReactNode;
  onSelect?: (id: NavId) => void;
  pendingApprovals?: number;
}) {
  let lastGroup = "";
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-surface/60 p-3 lg:flex xl:w-60 xl:p-4">
      <Brand />
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto pr-1" aria-label="Main">
        {NAV.map(({ id, label, icon: I, group }) => {
          const showGroup = group !== lastGroup;
          lastGroup = group;
          const classes = `flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors duration-200 ${
            active === id ? "bg-surface-3 font-medium text-ink" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
          }`;
          const content = <><I size={17} className={active === id ? "text-primary" : ""} />{label}{id === "Trades" && pendingApprovals > 0 && <span className="tnum ml-auto rounded-full bg-warn px-2 py-0.5 text-[11px] font-bold text-black">{pendingApprovals}</span>}</>;
          return <div key={id}>
            {showGroup && <div className="mb-1 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wider text-ink-faint first:mt-0">{group}</div>}
            {onSelect ? <button type="button" onClick={() => onSelect(id)} aria-current={active === id ? "page" : undefined} className={classes}>{content}</button>
              : <Link href={`/dashboard?tab=${encodeURIComponent(id)}`} aria-current={active === id ? "page" : undefined} className={classes}>{content}</Link>}
          </div>;
        })}
        <Link href="/scalping" aria-current={active === SCALPING_NAV_ID ? "page" : undefined}
          className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors duration-200 ${
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

const MOBILE_PRIMARY: NavId[] = ["Overview", "Trades", "Assistant", "Activity"];

/** Thumb-friendly mobile bottom navigation. Secondary destinations live in More. */
export function MobileBottomNav({ active, onSelect, pendingApprovals = 0 }: {
  active: string;
  onSelect?: (id: NavId) => void;
  pendingApprovals?: number;
}) {
  const [open, setOpen] = useState(false);
  const primary = NAV.filter((item) => MOBILE_PRIMARY.includes(item.id));
  const secondary = NAV.filter((item) => !MOBILE_PRIMARY.includes(item.id));
  const select = (id: NavId) => { setOpen(false); onSelect?.(id); };
  const destination = (id: NavId) => `/dashboard?tab=${encodeURIComponent(id)}`;
  const item = ({ id, label, icon: I }: (typeof NAV)[number]) => {
    const content = <><span className="relative"><I size={20} className={active === id ? "text-primary" : ""} />{id === "Trades" && pendingApprovals > 0 && <span className="absolute -right-2 -top-2 h-4 min-w-4 rounded-full bg-warn px-1 text-[9px] font-bold leading-4 text-black">{pendingApprovals}</span>}</span><span>{label}</span></>;
    const classes = `flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] ${active === id ? "font-semibold text-ink" : "text-ink-dim"}`;
    return onSelect ? <button type="button" key={id} className={classes} onClick={() => select(id)}>{content}</button>
      : <Link key={id} className={classes} href={destination(id)}>{content}</Link>;
  };
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
      {open && <section role="dialog" aria-modal="true" aria-label="More navigation" className="fixed inset-x-2 bottom-[4.8rem] z-50 max-h-[70dvh] overflow-y-auto rounded-2xl border border-line bg-surface p-3 shadow-2xl sm:left-auto sm:right-3 sm:w-96 sm:p-4 lg:hidden">
        <div className="mb-3 flex items-center justify-between"><div><h2 className="font-semibold">More</h2><p className="text-xs text-ink-faint">Tools, reports and configuration</p></div><button type="button" className="btn-ghost !p-2" onClick={() => setOpen(false)} aria-label="Close menu"><IconX size={18} /></button></div>
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
          {secondary.map(({ id, label, icon: I }) => {
            const content = <><I size={18} className={active === id ? "text-primary" : ""} /><span>{label}</span></>;
            const classes = `flex items-center gap-2 rounded-xl border p-3 text-sm ${active === id ? "border-primary bg-primary-dim/20 text-ink" : "border-line bg-surface-2 text-ink-dim"}`;
            return onSelect ? <button type="button" key={id} className={classes} onClick={() => select(id)}>{content}</button> : <Link key={id} className={classes} href={destination(id)}>{content}</Link>;
          })}
          <Link href="/scalping" className={`flex items-center gap-2 rounded-xl border p-3 text-sm ${active === SCALPING_NAV_ID ? "border-primary bg-primary-dim/20 text-ink" : "border-line bg-surface-2 text-ink-dim"}`}><IconZap size={18} /><span>Scalping Mode</span></Link>
        </div>
      </section>}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-bg/95 px-1 pb-[max(.25rem,env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(0,0,0,.28)] backdrop-blur sm:left-1/2 sm:max-w-xl sm:-translate-x-1/2 sm:rounded-t-2xl sm:border-x sm:px-2 lg:hidden" aria-label="Main">
        {primary.map(item)}
        <button type="button" onClick={() => setOpen(true)} className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] ${open || secondary.some((entry) => entry.id === active) || active === SCALPING_NAV_ID ? "font-semibold text-ink" : "text-ink-dim"}`} aria-expanded={open}><IconMore size={20} className={open ? "text-primary" : ""} /><span>More</span></button>
      </nav>
    </>
  );
}

/** Backward-compatible alias for standalone pages. */
export const MobileNav = MobileBottomNav;
