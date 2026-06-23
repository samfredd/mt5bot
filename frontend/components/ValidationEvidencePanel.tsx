"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface ValidationRun {
  id: string;
  candidateName: string;
  symbol: string;
  status: string;
  trainStart: string | null;
  trainEnd: string | null;
  oosStart: string | null;
  oosEnd: string | null;
  instruments: string[];
  metrics: { sensitivity?: { verdict?: string }; oos?: { monteCarlo?: { returnPct?: { p05?: number; p50?: number; p95?: number } } }; portfolio?: { meanReturnPct?: number; worstDrawdownPct?: number } };
  rejectionReasons: string[];
  createdAt: string;
}

export function ValidationEvidencePanel() {
  const [runs, setRuns] = useState<ValidationRun[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<ValidationRun[]>("/api/strategies/validation-runs?limit=20&includeInfrastructureErrors=false").then(setRuns).catch((err) => setError(String(err))); }, []);
  return <section className="panel"><p className="eyebrow">Research</p><h2 className="mb-4 text-lg font-semibold">Validation evidence</h2>
    <p className="mb-3 text-xs text-ink-faint">Showing strategy validation results. Temporary infrastructure errors are hidden from this list.</p>
    {error && <p className="text-sm text-down">Could not load validation runs: {error}</p>}
    {!error && runs === null && <p className="text-sm text-ink-faint">Loading validation evidence...</p>}
    {!error && runs?.length === 0 && <p className="text-sm text-ink-faint">No strategy validation has been recorded.</p>}
    <div className="space-y-3">{runs?.map((run) => <article className="card !p-3" key={run.id}><div className="flex items-center justify-between gap-3"><strong className="text-sm">{run.candidateName} · {run.symbol}</strong><span className={`chip ${statusClass(run.status)}`}>{run.status}</span></div><p className="mt-2 text-xs text-ink-dim">Train {date(run.trainStart)} to {date(run.trainEnd)} · OOS {date(run.oosStart)} to {date(run.oosEnd)}</p><p className="mt-1 text-xs text-ink-faint">Sensitivity: {run.metrics.sensitivity?.verdict ?? "n/a"} · MC return p05/p50/p95: {range(run.metrics.oos?.monteCarlo?.returnPct)} · Portfolio mean: {run.metrics.portfolio?.meanReturnPct ?? "n/a"}% · Worst DD: {run.metrics.portfolio?.worstDrawdownPct ?? "n/a"}%</p>{run.rejectionReasons?.length > 0 && <p className="mt-2 text-xs text-down">{run.rejectionReasons.join("; ")}</p>}</article>)}</div>
  </section>;
}

const date = (value: string | null) => value ? new Date(value).toLocaleDateString() : "n/a";
const range = (value?: { p05?: number; p50?: number; p95?: number }) => value ? `${value.p05 ?? 0}/${value.p50 ?? 0}/${value.p95 ?? 0}%` : "n/a";
const statusClass = (status: string) => {
  if (status === "PASSED") return "bg-emerald-950 text-up";
  if (status === "ERROR" || status === "INVALID") return "bg-amber-950 text-warn";
  return "bg-red-950 text-down";
};
