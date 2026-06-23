"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Comparison { id: string; direction: string; expectedEntry: number; actualEntry: number; entrySlippage: number; latencyMs: number | null; expectedPnl: number | null; actualPnl: number | null; pnlVariance: number | null; attributionConfidence: number | null; attributionReason: string | null; trade: { symbol: string; status: string }; }

export function ExecutionComparisonPanel() {
  const [rows, setRows] = useState<Comparison[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Comparison[]>("/api/execution-comparisons?limit=30").then(setRows).catch((err) => setError(String(err))); }, []);
  return <section className="panel"><p className="eyebrow">Broker quality</p><h2 className="mb-4 text-lg font-semibold">Expected versus actual execution</h2>
    {error && <p className="text-sm text-down">Could not load execution comparisons: {error}</p>}
    {!error && rows === null && <p className="text-sm text-ink-faint">Loading execution comparisons...</p>}
    {!error && rows?.length === 0 && <p className="text-sm text-ink-faint">No attributable broker fills recorded.</p>}
    <div className="overflow-x-auto">{rows && rows.length > 0 && <table className="w-full text-left text-xs"><thead className="text-ink-faint"><tr><th className="pb-2">Trade</th><th>Entry E/A</th><th>Slippage</th><th>Latency</th><th>P/L E/A</th><th>Attribution</th></tr></thead><tbody>{rows.map((row) => <tr className="border-t border-line" key={row.id}><td className="py-2 font-medium">{row.direction} {row.trade.symbol}</td><td>{row.expectedEntry} / {row.actualEntry}</td><td>{row.entrySlippage}</td><td>{row.latencyMs === null ? "n/a" : `${row.latencyMs}ms`}</td><td>{row.expectedPnl ?? "n/a"} / {row.actualPnl ?? "open"}</td><td>{row.attributionConfidence === null ? "pending" : `${Math.round(row.attributionConfidence * 100)}% ${row.attributionReason ?? ""}`}</td></tr>)}</tbody></table>}</div>
  </section>;
}
