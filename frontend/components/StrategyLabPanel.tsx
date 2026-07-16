"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconBrain } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";

interface WfConsistency {
  foldCount: number; profitableFolds: number; profitableFraction: number;
  meanReturnPct: number; stdevReturnPct: number; totalTrades: number; avgProfitFactor: number | null;
}
interface Proposal {
  name: string; rationale: string; symbol: string; style: string;
  status: "passed" | "failed" | "invalid" | "error";
  detail: string; walkForward?: WfConsistency;
  sensitivity?: { tested: number; robust: number; verdict: "robust" | "fragile" };
  savedStrategyId?: string;
}
interface LabRun {
  ranAt: string | null; trigger?: string; contextSummary?: string;
  webSearchEnabled?: boolean;
  proposals: Proposal[]; survivors: number;
}
interface LabProgress {
  runId: string;
  status: "idle" | "running" | "completed" | "failed";
  stage: "idle" | "context" | "generating" | "validating" | "recording" | "completed" | "failed";
  percent: number;
  message: string;
  completedCandidates: number;
  totalCandidates: number;
  startedAt: string | null;
  updatedAt: string;
}

export function StrategyLabPanel() {
  const toast = useToast();
  const [run, setRun] = useState<LabRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<LabProgress | null>(null);

  const load = useCallback(async () => {
    try { setRun(await api<LabRun>("/api/strategy-lab/last")); } catch { /* none yet */ }
  }, []);
  const loadProgress = useCallback(async () => {
    try {
      const next = await api<LabProgress>("/api/strategy-lab/progress");
      setProgress(next);
      setBusy(next.status === "running");
      if (next.status === "completed") void load();
      if (next.status === "failed") setError(next.message);
    } catch { /* retain the last visible progress snapshot */ }
  }, [load]);
  useEffect(() => { void load(); void loadProgress(); }, [load, loadProgress]);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => { void loadProgress(); }, 1_200);
    return () => window.clearInterval(timer);
  }, [busy, loadProgress]);

  async function generate() {
    setError("");
    setBusy(true);
    setProgress({
      runId: "starting",
      status: "running",
      stage: "context",
      percent: 1,
      message: "Starting Strategy Lab…",
      completedCandidates: 0,
      totalCandidates: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    try {
      const result = await api<LabRun>("/api/strategy-lab/run", { method: "POST", body: {} });
      setRun(result);
      await loadProgress();
      toast.success("Strategy Lab completed", result.survivors > 0 ? `${result.survivors} validated candidate(s) were saved disabled for review.` : "No candidate survived validation; nothing was enabled or saved as active.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Strategy Lab run failed.";
      setError(message);
      toast.error("Strategy Lab failed", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="section-title"><IconBrain size={15} className="text-primary" /> AI Strategy Lab</h2>
        <p className="mb-4 text-xs leading-relaxed text-ink-dim">
          The AI proposes strategy ideas from the current market regime + news; each is automatically
          validated with a 2-year walk-forward at realistic costs. Only survivors are saved — always{" "}
          <span className="text-ink">disabled</span> — for you to review and enable. This automates the search;
          it does not invent an edge. Expect most proposals to fail — that is the system working.
        </p>
        <button onClick={generate} disabled={busy} className="btn-primary">
          {busy ? "Generating & validating… (can take a minute)" : "Generate candidates"}
        </button>
        {progress && progress.status !== "idle" && (
          <div className="mt-4 rounded-xl border border-line bg-surface-2 p-3" aria-live="polite">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className={progress.status === "failed" ? "font-medium text-down" : progress.status === "completed" ? "font-medium text-up" : "font-medium text-ink"}>
                {progress.status === "running" ? "Strategy Lab running" : progress.status === "completed" ? "Strategy Lab complete" : "Strategy Lab failed"}
              </span>
              <span className="tnum text-ink-dim">
                {Math.round(progress.percent)}%
                {progress.totalCandidates > 0 ? ` · ${progress.completedCandidates}/${progress.totalCandidates} candidates` : ""}
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-label="Strategy Lab progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.percent)}
            >
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${progress.status === "failed" ? "bg-red-500" : progress.status === "completed" ? "bg-emerald-500" : "bg-primary"}`}
                style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-ink-dim">{progress.message}</p>
            {progress.startedAt && progress.status === "running" && (
              <p className="mt-1 text-[11px] text-ink-faint">Started {new Date(progress.startedAt).toLocaleTimeString()} · progress is saved if you leave this tab</p>
            )}
          </div>
        )}
        <p className="mt-3 text-xs text-ink-faint">
          Inputs: chart regime + economic calendar + live RSS headlines
          {run?.webSearchEnabled
            ? " + live web search ✓"
            : " · web search OFF (add a Tavily or Serper key in Settings → Operational configuration)"}
        </p>
        {error && <p className="mt-3 text-sm text-down" role="alert">{error}</p>}
      </section>

      {run?.ranAt && (
        <section className="card">
          <h2 className="section-title">
            Last run
            <span className="font-normal text-ink-faint">
              {new Date(run.ranAt).toLocaleString()} · {run.proposals.length} proposed · {run.survivors} passed
            </span>
          </h2>
          {run.survivors > 0 ? (
            <div className="mb-4 rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-3 text-sm text-up">
              {run.survivors} candidate(s) passed validation and were saved <b>disabled</b>. Review the rationale,
              then enable in the Strategies tab if you trust it (a demo forward-test first is wise).
            </div>
          ) : (
            <div className="mb-4 rounded-xl border border-amber-900/50 bg-amber-950/20 p-3 text-sm text-warn">
              No proposal survived validation this run — none had a robust edge. That is the expected, honest outcome.
            </div>
          )}
          <div className="space-y-3">
            {run.proposals.map((p, i) => <ProposalCard key={i} p={p} />)}
            {!run.proposals.length && <p className="text-sm text-ink-faint">The AI returned no valid proposals (model may be offline).</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function ProposalCard({ p }: { p: Proposal }) {
  const badge =
    p.status === "passed" ? "bg-emerald-950 text-up"
      : p.status === "failed" ? "bg-red-950 text-down"
        : "bg-amber-950 text-warn";
  const wf = p.walkForward;
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`chip ${badge}`}>{p.status.toUpperCase()}</span>
        <span className="text-sm font-medium text-ink">{p.name}</span>
        <span className="text-xs text-ink-faint">{p.symbol} · {p.style}</span>
        {p.savedStrategyId && <span className="chip bg-surface-3 text-ink-dim">saved (disabled)</span>}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-dim">{p.rationale}</p>
      {wf && (
        <div className="tnum mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
          <span>windows {wf.profitableFolds}/{wf.foldCount} profitable</span>
          <span className={wf.meanReturnPct > 0 ? "text-up" : "text-down"}>mean {wf.meanReturnPct >= 0 ? "+" : ""}{wf.meanReturnPct}%</span>
          <span>PF {wf.avgProfitFactor ?? "—"}</span>
          <span>{wf.totalTrades} trades</span>
          {p.sensitivity && (
            <span className={p.sensitivity.verdict === "robust" ? "text-up" : "text-warn"}>
              sensitivity {p.sensitivity.robust}/{p.sensitivity.tested} held ({p.sensitivity.verdict})
            </span>
          )}
        </div>
      )}
      <p className="mt-1.5 text-xs text-ink-faint">{p.detail}</p>
    </div>
  );
}
