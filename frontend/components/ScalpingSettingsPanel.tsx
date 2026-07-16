"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { ToastReporter } from "@/components/ToastProvider";

type Preset = "low" | "medium" | "aggressive" | "custom";
type ScalpConfig = {
  symbols: string[];
  useAiFireControl: boolean;
  aiMode: "STRICT" | "ADVISORY" | "PURE_LOGIC";
  minAiConfidence: number;
  aiDecisionTtlSeconds: number;
};
type ScalpRisk = {
  scalpingRiskPreset: Preset;
  lotMode: "fixed" | "risk_percent";
  riskPerTradePercent: number;
  maxTotalRiskExposurePercent: number;
  allowFixedLot: boolean;
  maxOpenTradesTotal: number;
  maxTradesPerSymbol: number;
  stopBasis: "money" | "points";
  targetProfitMoney: number;
  maxLossMoney: number;
  takeProfitPoints: number | null;
  stopLossPoints: number | null;
  profitTargetMoney: number | null;
  maxLotSize: number;
  reentryAfterWinSeconds: number;
  reentryAfterLossSeconds: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  pauseAfterLossStreakMinutes: number;
  dailyLossLimitMoney: number | null;
  dailyLossLimitPercent: number | null;
  maxSharedCurrencyExposure: number;
  maxSpreadPointsBySymbol: Record<string, number>;
  allowedSessions: string[];
  pauseDuringNews: boolean;
  pauseBeforeNewsMin: number;
  pauseAfterNewsMin: number;
  newsRiskLimit: "LOW" | "MEDIUM" | "HIGH";
  flattenBeforeHighImpactNews: boolean;
};

const numeric = (value: string, nullable = false) => value === "" && nullable ? null : Number(value);

function Field({ label, value, onChange, step = 1, min = 0, max, help }: {
  label: string; value: number | null; onChange: (value: number | null) => void; step?: number; min?: number; max?: number; help?: string;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input tnum" type="number" value={value ?? ""} step={step} min={min} max={max}
        onChange={(event) => onChange(numeric(event.target.value, value === null))} />
      {help && <span className="mt-1 block text-[11px] leading-relaxed text-ink-faint">{help}</span>}
    </label>
  );
}

export function ScalpingSettingsPanel({ onMsg }: { onMsg: ToastReporter }) {
  const [config, setConfig] = useState<ScalpConfig | null>(null);
  const [risk, setRisk] = useState<ScalpRisk | null>(null);
  const [symbols, setSymbols] = useState("");
  const [sessions, setSessions] = useState("");
  const [spreads, setSpreads] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const state = await api<{ config: ScalpConfig; risk: ScalpRisk }>("/api/scalping");
      setConfig(state.config);
      setRisk(state.risk);
      setSymbols(state.config.symbols.join(", "));
      setSessions(state.risk.allowedSessions.join(", "));
      setSpreads(Object.entries(state.risk.maxSpreadPointsBySymbol).map(([symbol, points]) => `${symbol}: ${points}`).join("\n"));
    } catch (error) {
      onMsg(error instanceof Error ? error.message : "Failed to load scalping settings.", "error");
    }
  }, [onMsg]);
  useEffect(() => { void load(); }, [load]);

  async function saveAll() {
    if (!config || !risk) return;
    setBusy(true); onMsg("");
    try {
      const parsedSpreads = Object.fromEntries(spreads.split(/\n|,/).map((row) => row.trim()).filter(Boolean).map((row) => {
        const [symbol, raw] = row.split(":").map((part) => part.trim());
        if (!symbol || !(Number(raw) > 0)) throw new Error(`Invalid spread limit: ${row}. Use SYMBOL: points.`);
        return [symbol.toUpperCase(), Number(raw)];
      }));
      const configPayload = {
        ...config,
        symbols: symbols.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
      };
      const riskPayload = {
        ...risk,
        allowedSessions: sessions.split(",").map((session) => session.trim()).filter(Boolean),
        maxSpreadPointsBySymbol: parsedSpreads,
      };
      await api("/api/scalping", { method: "PUT", body: configPayload });
      await api("/api/scalping/risk-settings", { method: "PUT", body: riskPayload });
      await load();
      onMsg("All scalping settings saved.");
    } catch (error) { onMsg(error instanceof Error ? error.message : "Failed to save scalping settings.", "error"); }
    finally { setBusy(false); }
  }

  if (!config || !risk) return <section id="scalping-settings" className="card"><p className="text-sm text-ink-dim">Loading scalping settings…</p></section>;
  const setR = (patch: Partial<ScalpRisk>) => setRisk({ ...risk, ...patch, scalpingRiskPreset: "custom" });

  return (
    <section id="scalping-settings" className="card scroll-mt-24">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-title">Scalping mode settings</h2>
          <p className="text-xs text-ink-dim">The single configuration point for scalping symbols, AI fire control, sizing, exits, limits, sessions, spreads and news handling.</p>
        </div>
        <Link href="/scalping" className="btn-ghost">Open scalping monitor</Link>
      </div>

      <p className="mt-3 text-xs text-ink-faint">No fixed preset is applied here. Every displayed value is editable and persisted as the active scalping configuration.</p>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl bg-surface-2 p-4">
          <h3 className="mb-3 text-sm font-semibold">Symbols and AI</h3>
          <label className="block"><span className="label">Watchlist</span><input className="input" value={symbols} onChange={(e) => setSymbols(e.target.value)} /></label>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={config.useAiFireControl} onChange={(e) => setConfig({ ...config, useAiFireControl: e.target.checked })} /> Use AI fire control</label>
          <label className="mt-3 block"><span className="label">Scalping AI mode</span><select className="input" value={config.aiMode} onChange={(e) => setConfig({ ...config, aiMode: e.target.value as ScalpConfig["aiMode"] })}><option value="STRICT">Strict</option><option value="ADVISORY">Advisory</option><option value="PURE_LOGIC">Pure logic</option></select></label>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Minimum AI confidence" value={config.minAiConfidence} step={0.01} onChange={(v) => setConfig({ ...config, minAiConfidence: Number(v) })} />
            <Field label="AI decision TTL (seconds)" value={config.aiDecisionTtlSeconds} min={10} onChange={(v) => setConfig({ ...config, aiDecisionTtlSeconds: Number(v) })} />
          </div>
        </div>

        <div className="rounded-xl bg-surface-2 p-4">
          <h3 className="mb-3 text-sm font-semibold">Position sizing and capacity</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="label">Lot mode</span><select className="input" value={risk.lotMode} onChange={(e) => setR({ lotMode: e.target.value as ScalpRisk["lotMode"] })}><option value="risk_percent">Risk percentage</option><option value="fixed">Fixed broker minimum</option></select></label>
            <Field label="Risk per trade (%)" value={risk.riskPerTradePercent} step={0.05} min={0.01} onChange={(v) => setR({ riskPerTradePercent: Number(v) })} />
            <Field label="Maximum total risk exposure (%)" value={risk.maxTotalRiskExposurePercent} step={0.1} min={0.01} onChange={(v) => setR({ maxTotalRiskExposurePercent: Number(v) })} />
            <Field label="Maximum lot size" value={risk.maxLotSize} step={0.01} min={0.01} onChange={(v) => setR({ maxLotSize: Number(v) })} />
            <Field label="Maximum open trades" value={risk.maxOpenTradesTotal} min={1} onChange={(v) => setR({ maxOpenTradesTotal: Number(v) })} />
            <Field label="Maximum per symbol" value={risk.maxTradesPerSymbol} min={1} help="Values above 1 require an MT5 hedging account and remain subject to the global per-symbol/open-trade limits." onChange={(v) => setR({ maxTradesPerSymbol: Number(v) })} />
            <Field label="Maximum trades/day" value={risk.maxTradesPerDay} min={1} onChange={(v) => setR({ maxTradesPerDay: Number(v) })} />
            <Field label="Shared currency exposure" value={risk.maxSharedCurrencyExposure} min={1} onChange={(v) => setR({ maxSharedCurrencyExposure: Number(v) })} />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={risk.allowFixedLot} onChange={(e) => setR({ allowFixedLot: e.target.checked })} /> Allow fixed-lot fallback</label>
        </div>

        <div className="rounded-xl bg-surface-2 p-4">
          <h3 className="mb-3 text-sm font-semibold">Exits and loss protection</h3>
          <label className="block"><span className="label">Stop/target basis</span><select className="input" value={risk.stopBasis} onChange={(e) => setR({ stopBasis: e.target.value as ScalpRisk["stopBasis"] })}><option value="money">Money</option><option value="points">Points</option></select></label>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Take profit ($)" value={risk.targetProfitMoney} step={0.01} min={0.01} onChange={(v) => setR({ targetProfitMoney: Number(v) })} />
            <Field label="Stop loss ($)" value={risk.maxLossMoney} step={0.01} min={0.01} onChange={(v) => setR({ maxLossMoney: Number(v) })} />
            <Field label="Take profit (points)" value={risk.takeProfitPoints} onChange={(v) => setR({ takeProfitPoints: v })} />
            <Field label="Stop loss (points)" value={risk.stopLossPoints} onChange={(v) => setR({ stopLossPoints: v })} />
            <Field label="Daily profit target ($)" value={risk.profitTargetMoney} step={0.01} onChange={(v) => setR({ profitTargetMoney: v })} />
            <Field label="Daily loss limit ($)" value={risk.dailyLossLimitMoney} step={0.01} onChange={(v) => setR({ dailyLossLimitMoney: v })} />
            <Field label="Daily loss limit (%)" value={risk.dailyLossLimitPercent} step={0.1} onChange={(v) => setR({ dailyLossLimitPercent: v })} />
            <Field label="Maximum consecutive losses" value={risk.maxConsecutiveLosses} min={1} onChange={(v) => setR({ maxConsecutiveLosses: Number(v) })} />
            <Field label="Pause after loss streak (min)" value={risk.pauseAfterLossStreakMinutes} onChange={(v) => setR({ pauseAfterLossStreakMinutes: Number(v) })} />
          </div>
        </div>

        <div className="rounded-xl bg-surface-2 p-4">
          <h3 className="mb-3 text-sm font-semibold">Execution, sessions and news</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Re-entry after win (seconds)" value={risk.reentryAfterWinSeconds} min={1} onChange={(v) => setR({ reentryAfterWinSeconds: Number(v) })} />
            <Field label="Re-entry after loss (seconds)" value={risk.reentryAfterLossSeconds} min={1} onChange={(v) => setR({ reentryAfterLossSeconds: Number(v) })} />
            <Field label="Pause before news (min)" value={risk.pauseBeforeNewsMin} onChange={(v) => setR({ pauseBeforeNewsMin: Number(v) })} />
            <Field label="Pause after news (min)" value={risk.pauseAfterNewsMin} onChange={(v) => setR({ pauseAfterNewsMin: Number(v) })} />
          </div>
          <label className="mt-3 block"><span className="label">Allowed sessions</span><input className="input" value={sessions} onChange={(e) => setSessions(e.target.value)} /></label>
          <label className="mt-3 block"><span className="label">Per-symbol maximum spreads (one SYMBOL: points per line)</span><textarea className="input min-h-28 font-mono text-xs" value={spreads} onChange={(e) => setSpreads(e.target.value)} /></label>
          <label className="mt-3 block"><span className="label">News risk limit</span><select className="input" value={risk.newsRiskLimit} onChange={(e) => setR({ newsRiskLimit: e.target.value as ScalpRisk["newsRiskLimit"] })}><option value="HIGH">High-impact only</option><option value="MEDIUM">Medium and high</option><option value="LOW">Low, medium and high</option></select></label>
          <div className="mt-3 space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={risk.pauseDuringNews} onChange={(e) => setR({ pauseDuringNews: e.target.checked })} /> Pause during news</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={risk.flattenBeforeHighImpactNews} onChange={(e) => setR({ flattenBeforeHighImpactNews: e.target.checked })} /> Flatten before high-impact news</label>
          </div>
        </div>
      </div>

      <button className="btn-primary mt-5" disabled={busy} onClick={() => void saveAll()}>{busy ? "Saving…" : "Save all scalping settings"}</button>
    </section>
  );
}
