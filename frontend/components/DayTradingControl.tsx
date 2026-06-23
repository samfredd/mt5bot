"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface DayTradingConfig {
  enabled: boolean;
  closeHourUtc: number;
  closeMinuteUtc: number;
}

/**
 * Day-trading (intraday-only) toggle. When on, the bot stops opening new
 * positions at the daily UTC cutoff and flattens everything still open — no
 * overnight holds. Configuration is backend-enforced in the scheduler.
 */
export function DayTradingControl() {
  const [cfg, setCfg] = useState<DayTradingConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try { setCfg(await api<DayTradingConfig>("/api/day-trading")); } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!cfg) return null;
  const pad = (n: number) => String(n).padStart(2, "0");

  async function save(patch: Partial<DayTradingConfig>) {
    setMessage(""); setBusy(true);
    try { setCfg(await api<DayTradingConfig>("/api/day-trading", { method: "PUT", body: patch })); }
    catch (err) { setMessage(err instanceof Error ? err.message : "update failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void save({ enabled: !cfg.enabled })}
          disabled={busy}
          className={`btn ${cfg.enabled ? "bg-teal-900 text-teal-200 ring-1 ring-teal-800" : "btn-ghost"} disabled:opacity-50`}
        >
          Day trading: {cfg.enabled ? "ON" : "OFF"}
        </button>
        <div className="flex items-center gap-1.5 text-xs text-ink-dim">
          <span>Daily close (UTC)</span>
          <input
            type="number" min={0} max={23} value={cfg.closeHourUtc} disabled={busy}
            onChange={(e) => setCfg({ ...cfg, closeHourUtc: Number(e.target.value) })}
            onBlur={(e) => void save({ closeHourUtc: Number(e.target.value) })}
            className="input !w-14 !py-1 text-center"
          />
          <span>:</span>
          <input
            type="number" min={0} max={59} value={cfg.closeMinuteUtc} disabled={busy}
            onChange={(e) => setCfg({ ...cfg, closeMinuteUtc: Number(e.target.value) })}
            onBlur={(e) => void save({ closeMinuteUtc: Number(e.target.value) })}
            className="input !w-14 !py-1 text-center"
          />
        </div>
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        Intraday-only: after {pad(cfg.closeHourUtc)}:{pad(cfg.closeMinuteUtc)} UTC the bot stops opening trades and
        flattens all open positions — nothing is held overnight.
      </p>
      {message && <p className="mt-2 text-sm text-warn" role="status">{message}</p>}
    </div>
  );
}
