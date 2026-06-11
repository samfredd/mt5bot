"use client";
import { useCallback, useEffect, useState } from "react";
import { api, setToken } from "@/lib/api";
import { IconLogout, IconShield } from "@/components/icons";

type Risk = Record<string, unknown> & { id?: string; userId?: string };

const FIELDS: { key: string; label: string; step?: string }[] = [
  { key: "maxRiskPerTradePct", label: "Max risk per trade (%)", step: "0.1" },
  { key: "maxDailyLossPct", label: "Max daily loss (%)", step: "0.5" },
  { key: "maxWeeklyLossPct", label: "Max weekly loss (%)", step: "0.5" },
  { key: "maxDrawdownPct", label: "Max drawdown (%)", step: "1" },
  { key: "maxOpenTrades", label: "Max open trades" },
  { key: "maxTradesPerSymbol", label: "Max trades per symbol" },
  { key: "maxTradesPerDay", label: "Max trades per day" },
  { key: "maxLotSize", label: "Max lot size", step: "0.01" },
  { key: "minRiskReward", label: "Min risk:reward", step: "0.1" },
  { key: "maxSpreadPoints", label: "Max spread (points)" },
  { key: "maxConsecutiveLosses", label: "Stop after N losses" },
  { key: "pauseBeforeNewsMin", label: "Pause before news (min)" },
  { key: "pauseAfterNewsMin", label: "Pause after news (min)" },
  { key: "equityProtectionPct", label: "Equity floor (%)" },
  { key: "copyExposureLimitPct", label: "Copy exposure limit (%)" },
];

export function SettingsPanel() {
  const [risk, setRisk] = useState<Risk>({});
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");

  const load = useCallback(async () => {
    try { setRisk(await api<Risk>("/api/risk-settings")); } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setMessage("");
    try {
      const { id, userId, ...payload } = risk;
      await api("/api/risk-settings", { method: "PUT", body: payload });
      setMessage("Risk settings saved.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "failed"); }
  }

  async function linkConnector(kind: "telegram" | "whatsapp") {
    try {
      const res = await api<{ instructions: string }>(`/auth/link/${kind}`, { method: "POST" });
      setLink(res.instructions);
    } catch (err) { setLink(err instanceof Error ? err.message : "failed"); }
  }

  async function setup2fa() {
    const res = await api<{ secret: string; otpauthUrl: string }>("/auth/2fa/setup", { method: "POST" });
    setTotpSetup(res);
  }

  async function enable2fa() {
    try {
      await api("/auth/2fa/enable", { method: "POST", body: { token: totpCode } });
      setMessage("2FA enabled."); setTotpSetup(null);
    } catch (err) { setMessage(err instanceof Error ? err.message : "failed"); }
  }

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="section-title"><IconShield size={15} className="text-primary" /> Risk settings</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`risk-${f.key}`} className="label">{f.label}</label>
              <input id={`risk-${f.key}`} type="number" step={f.step ?? "1"} inputMode="decimal"
                className="input tnum"
                value={String(risk[f.key] ?? "")}
                onChange={(e) => setRisk({ ...risk, [f.key]: Number(e.target.value) })} />
            </div>
          ))}
          <div>
            <label htmlFor="risk-news-limit" className="label">News risk limit</label>
            <select id="risk-news-limit" className="input cursor-pointer"
              value={String(risk.newsRiskLimit ?? "MEDIUM")}
              onChange={(e) => setRisk({ ...risk, newsRiskLimit: e.target.value })}>
              <option>LOW</option><option>MEDIUM</option><option>HIGH</option>
            </select>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-6">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-dim">
            <input type="checkbox" className="accent-teal-500" checked={Boolean(risk.requireStopLoss ?? true)}
              onChange={(e) => setRisk({ ...risk, requireStopLoss: e.target.checked })} />
            Require stop-loss <span className="text-ink-faint">(admin-only to disable)</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-dim">
            <input type="checkbox" className="accent-teal-500" checked={Boolean(risk.allowNewsTrading ?? false)}
              onChange={(e) => setRisk({ ...risk, allowNewsTrading: e.target.checked })} />
            Allow trading through news <span className="text-ink-faint">(reduced size)</span>
          </label>
        </div>
        <button onClick={save} className="btn-primary mt-4">Save risk settings</button>
      </section>

      <ScannerSettings onMsg={setMessage} />

      <section className="card">
        <h2 className="section-title">Connectors</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => linkConnector("telegram")} className="btn bg-sky-950 text-sky-300 ring-1 ring-sky-900 hover:bg-sky-900 hover:text-sky-100">Link Telegram</button>
          <button onClick={() => linkConnector("whatsapp")} className="btn bg-emerald-950 text-emerald-300 ring-1 ring-emerald-900 hover:bg-emerald-900 hover:text-emerald-100">Link WhatsApp</button>
        </div>
        {link && <p className="tnum mt-3 rounded-xl bg-bg p-3 font-mono text-sm text-warn">{link}</p>}
      </section>

      <section className="card">
        <h2 className="section-title">Two-factor authentication</h2>
        <p className="mb-3 text-xs text-ink-dim">Required for any live-trading action (enabling live mode, approving live trades).</p>
        {!totpSetup ? (
          <button onClick={setup2fa} className="btn-ghost">Set up 2FA</button>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-ink-dim">Add this secret to your authenticator app:</p>
            <p className="tnum rounded-xl bg-bg p-3 font-mono text-warn">{totpSetup.secret}</p>
            <div className="flex gap-2">
              <label htmlFor="totp-code" className="sr-only">6-digit code</label>
              <input id="totp-code" className="input tnum !w-36" placeholder="6-digit code" inputMode="numeric"
                value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
              <button onClick={enable2fa} className="btn-primary">Verify & enable</button>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <button onClick={() => { setToken(null); window.location.href = "/login"; }} className="btn-ghost">
          <IconLogout size={15} /> Sign out
        </button>
      </section>

      {message && <p className="text-sm text-warn" role="status">{message}</p>}
    </div>
  );
}

function ScannerSettings({ onMsg }: { onMsg: (m: string) => void }) {
  const [cfg, setCfg] = useState<{ enabled: boolean; symbols: string[]; intervalMin: number; maxPerDay: number; minScore: number } | null>(null);
  const [symbolsText, setSymbolsText] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const c = await api<NonNullable<typeof cfg>>("/api/scanner");
        setCfg(c);
        setSymbolsText(c.symbols.join(", "));
      } catch { /* noop */ }
    })();
  }, []);

  if (!cfg) return null;

  async function save() {
    try {
      const symbols = symbolsText.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      const next = await api<NonNullable<typeof cfg>>("/api/scanner", { method: "PUT", body: { ...cfg, symbols } });
      setCfg(next);
      setSymbolsText(next.symbols.join(", "));
      onMsg("Scanner settings saved.");
    } catch (err) {
      onMsg(err instanceof Error ? err.message : "failed");
    }
  }

  return (
    <section className="card">
      <h2 className="section-title">Autonomous scanner</h2>
      <p className="mb-4 text-xs leading-relaxed text-ink-dim">
        Sweeps the watchlist on its own, suggests the best setup with AI reasoning, and asks your approval —
        you choose the lot size on every trade. It never executes by itself.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="col-span-2 md:col-span-4">
          <label htmlFor="scanner-symbols" className="label">Watchlist (comma-separated)</label>
          <input id="scanner-symbols" className="input" value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} />
        </div>
        <div>
          <label htmlFor="scanner-interval" className="label">Scan every (min)</label>
          <input id="scanner-interval" className="input tnum" type="number" min={2} value={cfg.intervalMin}
            onChange={(e) => setCfg({ ...cfg, intervalMin: Number(e.target.value) })} />
        </div>
        <div>
          <label htmlFor="scanner-max" className="label">Max suggestions/day</label>
          <input id="scanner-max" className="input tnum" type="number" min={1} value={cfg.maxPerDay}
            onChange={(e) => setCfg({ ...cfg, maxPerDay: Number(e.target.value) })} />
        </div>
        <div>
          <label htmlFor="scanner-score" className="label">Min confluence (2–6)</label>
          <input id="scanner-score" className="input tnum" type="number" min={2} max={6} value={cfg.minScore}
            onChange={(e) => setCfg({ ...cfg, minScore: Number(e.target.value) })} />
        </div>
        <label className="flex cursor-pointer items-end gap-2 pb-2.5 text-xs text-ink-dim">
          <input type="checkbox" className="accent-teal-500" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
          Enabled
        </label>
      </div>
      <button onClick={save} className="btn-primary mt-4">Save scanner settings</button>
    </section>
  );
}
