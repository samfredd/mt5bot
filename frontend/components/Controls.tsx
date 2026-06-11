"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { IconPause, IconPlay, IconRefresh, IconScan, IconStop } from "@/components/icons";

export function Controls({ onChanged, state }: { onChanged: () => void; state?: { status: string; mode: string; emergencyStop: boolean } }) {
  const [message, setMessage] = useState("");
  const [scanning, setScanning] = useState(false);

  async function call(path: string, body?: unknown) {
    setMessage("");
    try {
      await api(path, { method: "POST", body });
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Request failed");
    }
  }

  async function scanNow() {
    setMessage("");
    setScanning(true);
    try {
      const r = await api<{ scanned: number; candidates: unknown[]; suggested: { symbol: string; direction: string } | null; skippedReason?: string }>("/api/scanner/run", { method: "POST" });
      setMessage(r.suggested
        ? `Scan complete — suggested ${r.suggested.direction.toUpperCase()} ${r.suggested.symbol}. Check pending approvals.`
        : `Scan complete — ${r.scanned} symbols, ${r.candidates.length} candidate(s). ${r.skippedReason ?? ""}`);
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  return (
    <section className="card">
      <h2 className="section-title">Trading controls</h2>
      <div className="flex flex-wrap items-center gap-2.5">
        <button onClick={() => call("/api/bot/start")} className="btn bg-emerald-900 text-emerald-200 ring-1 ring-emerald-800 hover:bg-emerald-800 hover:text-white">
          <IconPlay size={15} /> Start
        </button>
        <button onClick={() => call("/api/bot/pause")} className="btn bg-amber-950 text-amber-300 ring-1 ring-amber-900 hover:bg-amber-900 hover:text-amber-100">
          <IconPause size={15} /> Pause
        </button>
        <button
          onClick={() => { if (confirm("EMERGENCY STOP halts the bot and closes ALL open positions. Continue?")) void call("/api/bot/emergency-stop"); }}
          className="btn-danger font-semibold">
          <IconStop size={15} /> Emergency stop
        </button>
        {state?.emergencyStop && (
          <button onClick={() => call("/api/bot/emergency-reset")} className="btn-ghost">
            <IconRefresh size={15} /> Reset emergency stop
          </button>
        )}
        <button onClick={scanNow} disabled={scanning}
          className="btn bg-violet-950 text-violet-300 ring-1 ring-violet-900 hover:bg-violet-900 hover:text-violet-100">
          <IconScan size={15} className={scanning ? "animate-spin" : ""} />
          {scanning ? "Scanning…" : "Scan market now"}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <label htmlFor="mode-select" className="text-xs text-ink-dim">Mode</label>
          <select id="mode-select" value={state?.mode ?? "MANUAL"} onChange={(e) => call("/api/bot/mode", { mode: e.target.value })}
            className="input !w-auto cursor-pointer !py-2">
            <option value="MANUAL">Manual — analysis only</option>
            <option value="SEMI_AUTO">Semi-auto — approval required</option>
            <option value="AUTO">Automatic</option>
            <option value="COPY">Copy trading</option>
          </select>
        </div>
      </div>
      {message && <p className="mt-3 text-sm text-warn" role="status">{message}</p>}
    </section>
  );
}
