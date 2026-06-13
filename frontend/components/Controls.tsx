"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconBrain, IconPause, IconPlay, IconRefresh, IconScan, IconStop } from "@/components/icons";

interface ScanResponse {
  scanned: number;
  candidates: unknown[];
  suggested: { symbol: string; direction: string } | null;
  skippedReason?: string;
  directedAnalysis?: { symbol: string; direction: string | null; score: number; reasons: string[] };
}

export function Controls({ onChanged, state }: { onChanged: () => void; state?: { status: string; mode: string; emergencyStop: boolean } }) {
  const [message, setMessage] = useState("");
  const [scanning, setScanning] = useState(false);
  const [researching, setResearching] = useState(false);
  const [symbols, setSymbols] = useState<string[]>(["EURUSD"]);
  const [pair, setPair] = useState("EURUSD");

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ symbols: string[] }>("/api/symbols");
        if (r.symbols.length) setSymbols(r.symbols);
      } catch { /* keep fallback */ }
    })();
  }, []);

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
      const r = await api<ScanResponse>("/api/scanner/run", { method: "POST", body: {} });
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

  async function researchPair() {
    setMessage("");
    setResearching(true);
    try {
      const r = await api<ScanResponse>("/api/scanner/run", { method: "POST", body: { symbol: pair } });
      if (r.suggested) {
        setMessage(`${pair}: suggested ${r.suggested.direction.toUpperCase()} — review it in pending approvals (you set the lot size).`);
      } else {
        const d = r.directedAnalysis;
        const detail = d ? ` Analysis: ${d.direction ? `${d.direction.toUpperCase()} bias, confluence ${d.score}/6` : "no clear direction"} — ${d.reasons[d.reasons.length - 1] ?? ""}` : "";
        setMessage(`${pair}: no trade suggested. ${r.skippedReason ?? ""}${detail}`);
      }
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Research failed");
    } finally {
      setResearching(false);
    }
  }

  const status = state?.status ?? "stopped";
  const running = status === "running";
  const isEmergency = !!state?.emergencyStop || status === "emergency_stop";

  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="section-title !mb-0">Trading controls</h2>
        <ControlsStatus status={status} emergencyStop={isEmergency} />
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <button onClick={() => call("/api/bot/start")} disabled={running || isEmergency}
          className={`btn bg-emerald-900 text-emerald-200 ring-1 ring-emerald-800 hover:bg-emerald-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-emerald-900 disabled:hover:text-emerald-200 ${running ? "ring-2 ring-emerald-400" : ""}`}>
          <IconPlay size={15} /> {running ? "Running" : "Start"}
        </button>
        <button onClick={() => call("/api/bot/pause")} disabled={!running}
          className="btn bg-amber-950 text-amber-300 ring-1 ring-amber-900 hover:bg-amber-900 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-amber-950 disabled:hover:text-amber-300">
          <IconPause size={15} /> {status === "paused" ? "Paused" : "Pause"}
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
      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <div>
          <label htmlFor="research-pair" className="label">Direct the bot at a pair</label>
          <select id="research-pair" className="input cursor-pointer !w-44" value={pair} onChange={(e) => setPair(e.target.value)}>
            {!symbols.includes(pair) && <option value={pair}>{pair}</option>}
            {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button onClick={researchPair} disabled={researching}
          className="btn bg-sky-950 text-sky-300 ring-1 ring-sky-900 hover:bg-sky-900 hover:text-sky-100">
          <IconBrain size={15} className={researching ? "animate-pulse" : ""} />
          {researching ? "Researching…" : "Research & suggest trade"}
        </button>
        <p className="w-full text-xs text-ink-faint sm:w-auto sm:flex-1">
          Deep-analyzes the pair (multi-timeframe technicals, news, AI reasoning) and creates an approval
          request if a setup exists — or use “Scan market now” to let it pick the best pair itself.
        </p>
      </div>
      {message && <p className="mt-3 text-sm text-warn" role="status">{message}</p>}
    </section>
  );
}

function ControlsStatus({ status, emergencyStop }: { status: string; emergencyStop: boolean }) {
  const cfg = emergencyStop
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
