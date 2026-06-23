"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconBrain } from "@/components/icons";

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

export function StrategyLabPanel() {
  const [run, setRun] = useState<LabRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setRun(await api<LabRun>("/api/strategy-lab/last")); } catch { /* none yet */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function generate() {
    setError("");
    setBusy(true);
    try {
      setRun(await api<LabRun>("/api/strategy-lab/run", { method: "POST", body: {} }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "lab run failed");
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
        <p className="mt-3 text-xs text-ink-faint">
          Inputs: chart regime + economic calendar + live RSS headlines
          {run?.webSearchEnabled
            ? " + live web search ✓"
            : " · web search OFF (set WEB_SEARCH_API_KEY in backend .env — free key at tavily.com)"}
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
