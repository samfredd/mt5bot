"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconBrain, IconPause, IconPlay, IconRefresh, IconScan, IconStop } from "@/components/icons";
import { DayTradingControl } from "@/components/DayTradingControl";
import { useToast } from "@/components/ToastProvider";

interface ScanResponse {
  scanned: number;
  candidates: unknown[];
  suggested: { symbol: string; direction: string } | null;
  executed?: { symbol: string; direction: string; lots: number };
  paper?: { symbol: string; direction: string; lots: number };
  skippedReason?: string;
  directedAnalysis?: { symbol: string; direction: string | null; score: number; reasons: string[] };
}

export function Controls({ onChanged, state }: { onChanged: () => void; state?: { status: string; mode: string; emergencyStop: boolean } }) {
  const toast = useToast();
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
    try {
      await api(path, { method: "POST", body });
      const description = controlMessage(path, body);
      if (path.includes("emergency-stop")) toast.warning("Emergency stop executed", description);
      else toast.success("Trading controls updated", description);
      onChanged();
    } catch (err) {
      toast.error("Control request failed", err instanceof Error ? err.message : "The trading control could not be updated.");
    }
  }

  async function scanNow() {
    setScanning(true);
    try {
      const r = await api<ScanResponse>("/api/scanner/run", { method: "POST", body: {} });
      const result = r.executed
        ? `Scan complete — executed ${r.executed.direction.toUpperCase()} ${r.executed.symbol} (${r.executed.lots} lots).`
        : r.paper
          ? `Scan complete — opened paper ${r.paper.direction.toUpperCase()} ${r.paper.symbol} (${r.paper.lots} lots).`
          : r.suggested
            ? `Scan complete — suggested ${r.suggested.direction.toUpperCase()} ${r.suggested.symbol}. Check pending approvals.`
            : `Scan complete — ${r.scanned} symbols, ${r.candidates.length} candidate(s). ${r.skippedReason ?? ""}`;
      (r.executed || r.paper ? toast.success : toast.info)("Market scan completed", result);
      onChanged();
    } catch (err) {
      toast.error("Market scan failed", err instanceof Error ? err.message : "The scan could not be completed.");
    } finally {
      setScanning(false);
    }
  }

  async function researchPair() {
    setResearching(true);
    try {
      const r = await api<ScanResponse>("/api/scanner/run", { method: "POST", body: { symbol: pair } });
      if (r.executed) {
        toast.success("Trade executed", `${pair}: ${r.executed.direction.toUpperCase()} (${r.executed.lots} lots).`);
      } else if (r.paper) {
        toast.success("Paper trade opened", `${pair}: ${r.paper.direction.toUpperCase()} (${r.paper.lots} lots).`);
      } else if (r.suggested) {
        toast.info("Trade suggestion ready", `${pair}: ${r.suggested.direction.toUpperCase()} — review it in pending approvals and choose the lot size.`);
      } else {
        const d = r.directedAnalysis;
        const detail = d ? ` Analysis: ${d.direction ? `${d.direction.toUpperCase()} bias, confluence ${d.score}/6` : "no clear direction"} — ${d.reasons[d.reasons.length - 1] ?? ""}` : "";
        toast.info("Research completed", `${pair}: no trade suggested. ${r.skippedReason ?? ""}${detail}`);
      }
      onChanged();
    } catch (err) {
      toast.error("Research failed", err instanceof Error ? err.message : "The pair could not be analyzed.");
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
          Deep-analyzes the pair (multi-timeframe technicals, news, AI reasoning) and in Automatic mode
          executes a passing setup; otherwise it creates an approval request.
        </p>
      </div>
      <DayTradingControl />
    </section>
  );
}

function controlMessage(path: string, body?: unknown): string {
  if (path.endsWith("/start")) return "The bot is running.";
  if (path.endsWith("/pause")) return "The bot is paused.";
  if (path.endsWith("/emergency-stop")) return "The bot was halted and the close-position workflow was requested.";
  if (path.endsWith("/emergency-reset")) return "Emergency state was reset.";
  if (path.endsWith("/mode")) return `Trading mode changed to ${String((body as { mode?: string } | undefined)?.mode ?? "the selected mode").replace(/_/g, " ").toLowerCase()}.`;
  return "The requested change was applied.";
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
