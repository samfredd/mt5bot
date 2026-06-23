"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Exposure { accountEquity: number; currencyUsd: Record<string, number>; symbolUsd: Record<string, number>; correlationGroups: Record<string, { grossUsd: number; netUsd: number }>; }

export function ExposurePanel() {
  const [data, setData] = useState<Exposure | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Exposure>("/api/exposure").then(setData).catch((err) => setError(String(err))); }, []);
  return <section className="panel"><p className="eyebrow">Risk</p><h2 className="mb-4 text-lg font-semibold">Currency and correlation exposure</h2>
    {error && <p className="text-sm text-down">Could not load exposure: {error}</p>}
    {!error && !data && <p className="text-sm text-ink-faint">Loading exposure...</p>}
    {data && Object.keys(data.symbolUsd).length === 0 && <p className="text-sm text-ink-faint">No open broker positions.</p>}
    {data && <div className="grid gap-4 md:grid-cols-2"><Table title="Currency net USD" rows={data.currencyUsd}/><Table title="Symbol net USD" rows={data.symbolUsd}/><div className="md:col-span-2"><h3 className="mb-2 text-xs font-medium text-ink-faint">Correlation groups</h3><div className="grid gap-2 sm:grid-cols-2">{Object.entries(data.correlationGroups).map(([name, value]) => <div className="card !p-3 text-xs" key={name}><div className="flex justify-between"><strong>{name}</strong><span>{pct(value.grossUsd, data.accountEquity)}% gross</span></div><p className="mt-1 text-ink-faint">Gross {value.grossUsd.toFixed(2)} · Net {value.netUsd.toFixed(2)}</p></div>)}</div></div></div>}
  </section>;
}

function Table({ title, rows }: { title: string; rows: Record<string, number> }) { return <div><h3 className="mb-2 text-xs font-medium text-ink-faint">{title}</h3><div className="space-y-1">{Object.entries(rows).map(([key, value]) => <div className="card flex justify-between !p-2 text-xs" key={key}><span>{key}</span><span className={`tnum ${value >= 0 ? "text-up" : "text-down"}`}>{value.toFixed(2)}</span></div>)}</div></div>; }
const pct = (value: number, equity: number) => equity > 0 ? ((Math.abs(value) / equity) * 100).toFixed(0) : "0";
