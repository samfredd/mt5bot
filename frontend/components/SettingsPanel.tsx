"use client";
import { useCallback, useEffect, useState } from "react";
import { api, setToken } from "@/lib/api";
import { buildLiveTradingRequestBody } from "@/lib/live-settings";
import { IconLogout, IconShield } from "@/components/icons";
import { AiProviderSwitch } from "@/components/AiProviderSwitch";

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

  return (
    <div className="space-y-6">
      <AccountSection onMsg={setMessage} />

      <LiveTradingSettings onMsg={setMessage} />

      <AiProviderSwitch />

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
        <button onClick={() => { setToken(null); window.location.href = "/login"; }} className="btn-ghost">
          <IconLogout size={15} /> Sign out
        </button>
      </section>

      {message && <p className="text-sm text-warn" role="status">{message}</p>}
    </div>
  );
}

interface AccountsData {
  saved: { id: string; label: string; login: string; server: string; isDemo: boolean; verified: boolean }[];
  current: { login: string; balance: number; currency: string; is_demo: boolean } | null;
  userLiveEnabled: boolean;
}

function AccountSection({ onMsg }: { onMsg: (m: string) => void }) {
  const [data, setData] = useState<AccountsData | null>(null);
  const [form, setForm] = useState({ label: "", login: "", password: "", server: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api<AccountsData>("/api/mt5/accounts")); } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    const isLikelyReal = !form.server.toLowerCase().includes("demo");
    if (isLikelyReal && !confirm(
      `"${form.server}" does not look like a demo server.\n\nConnecting switches the WHOLE terminal to this account, and the bot will trade REAL MONEY on it once live trading is enabled.\n\nContinue?`,
    )) return;
    setBusy(true);
    onMsg("");
    try {
      const res = await api<{ ok: boolean; balance?: number; currency?: string; account: { isDemo: boolean } }>("/api/mt5/connect", {
        method: "POST",
        body: { label: form.label || `${form.login}@${form.server}`, login: form.login, password: form.password, server: form.server },
      });
      onMsg(`Connected: ${form.login} on ${form.server} (${res.account.isDemo ? "DEMO" : "REAL"}) — balance ${res.balance?.toFixed(2)} ${res.currency ?? ""}.`);
      setForm({ label: "", login: "", password: "", server: "" });
      await load();
    } catch (err) {
      onMsg(err instanceof Error ? err.message : "connection failed");
    } finally {
      setBusy(false);
    }
  }

  async function reconnect(id: string) {
    onMsg("");
    try {
      const res = await api<{ ok: boolean; login: string; isDemo: boolean }>(`/api/mt5/accounts/${id}/reconnect`, { method: "POST" });
      onMsg(`Reconnected to ${res.login} (${res.isDemo ? "DEMO" : "REAL"}).`);
      await load();
    } catch (err) { onMsg(err instanceof Error ? err.message : "reconnect failed"); }
  }

  async function toggleLive(enable: boolean) {
    onMsg("");
    if (enable && !confirm("Enable LIVE trading? The bot will be allowed to place real-money trades on a real account (demo accounts are unaffected). The risk engine and approval flow still apply.")) return;
    const token = enable ? window.prompt("Enter your 2FA code to enable live trading") : null;
    if (enable && token === null) return;
    try {
      await api(enable ? "/auth/live/enable" : "/auth/live/disable", { method: "POST", body: buildLiveTradingRequestBody(enable, token) });
      onMsg(enable ? "Live trading ENABLED." : "Live trading disabled.");
      await load();
    } catch (err) { onMsg(err instanceof Error ? err.message : "failed"); }
  }

  return (
    <section className="card">
      <h2 className="section-title">MT5 account & live trading</h2>

      {data?.current && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 text-sm">
          <span className={`chip ${data.current.is_demo ? "bg-emerald-950 text-up" : "bg-red-950 text-down"}`}>
            {data.current.is_demo ? "DEMO" : "REAL"}
          </span>
          <span className="font-medium">Connected: {data.current.login}</span>
          <span className="tnum text-ink-dim">{data.current.balance.toFixed(2)} {data.current.currency}</span>
          <span className="ml-auto flex items-center gap-2">
            <span className="text-xs text-ink-faint">Live trading</span>
            {data.userLiveEnabled ? (
              <button onClick={() => toggleLive(false)} className="btn btn-sm bg-emerald-900 text-emerald-100 hover:bg-emerald-800">Enabled — click to disable</button>
            ) : (
              <button onClick={() => toggleLive(true)} className="btn-danger btn-sm">Locked — click to enable</button>
            )}
          </span>
        </div>
      )}

      <form onSubmit={connect} className="grid grid-cols-2 items-end gap-3 lg:grid-cols-5">
        <div>
          <label htmlFor="acc-label" className="label">Label</label>
          <input id="acc-label" className="input" placeholder="e.g. Real account" value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </div>
        <div>
          <label htmlFor="acc-login" className="label">Account number</label>
          <input id="acc-login" className="input tnum" inputMode="numeric" placeholder="12345678" value={form.login}
            onChange={(e) => setForm({ ...form, login: e.target.value })} required />
        </div>
        <div>
          <label htmlFor="acc-server" className="label">Server (exact name)</label>
          <input id="acc-server" className="input" placeholder="Broker-Demo" value={form.server}
            onChange={(e) => setForm({ ...form, server: e.target.value })} required />
        </div>
        <div>
          <label htmlFor="acc-pass" className="label">Password</label>
          <input id="acc-pass" className="input" type="password" autoComplete="off" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </div>
        <button disabled={busy} className="btn-primary">{busy ? "Connecting…" : "Switch account"}</button>
      </form>
      <p className="mt-2 text-xs text-ink-faint">
        Switching changes the account for the whole terminal. Credentials are encrypted at rest and never logged.
      </p>

      {data && data.saved.length > 0 && (
        <div className="mt-4 space-y-2">
          {data.saved.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-4 py-2.5 text-sm">
              <span className="flex items-center gap-2">
                <span className={`chip !text-[10px] ${a.isDemo ? "bg-emerald-950 text-up" : "bg-red-950 text-down"}`}>{a.isDemo ? "DEMO" : "REAL"}</span>
                <span className="font-medium">{a.label}</span>
                <span className="tnum text-xs text-ink-faint">{a.login} · {a.server}</span>
              </span>
              <button onClick={() => reconnect(a.id)} className="btn-ghost btn-sm">Reconnect</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface LiveState {
  liveTradingEnabled: boolean;
  requireLiveTwoFactor: boolean;
  autoLiveAuthorized: boolean;
}

function Toggle({ label, hint, checked, onChange, danger }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; danger?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-surface-2 px-4 py-3">
      <input type="checkbox" className={`mt-0.5 ${danger ? "accent-red-500" : "accent-teal-500"}`}
        checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-sm">
        <span className="font-medium">{label}</span>
        <span className="block text-xs leading-relaxed text-ink-faint">{hint}</span>
      </span>
    </label>
  );
}

function LiveTradingSettings({ onMsg }: { onMsg: (m: string) => void }) {
  const [state, setState] = useState<LiveState | null>(null);

  const load = useCallback(async () => {
    try { setState(await api<LiveState>("/api/bot/state")); } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!state) return null;
  const set = (patch: Partial<LiveState>) => setState({ ...state, ...patch });

  async function save() {
    if (!state) return;
    if (state.liveTradingEnabled && !confirm(
      "Save live-trading settings?\n\nWith the system switch ON — plus the per-account live toggle and a real account connected — the bot will be allowed to place REAL-MONEY orders. The risk engine still applies. Continue?",
    )) return;
    onMsg("");
    try {
      const next = await api<LiveState>("/api/bot/live-settings", {
        method: "PUT",
        body: {
          liveTradingEnabled: state.liveTradingEnabled,
          requireLiveTwoFactor: state.requireLiveTwoFactor,
          autoLiveAuthorized: state.autoLiveAuthorized,
        },
      });
      setState(next);
      onMsg("Live-trading settings saved.");
    } catch (err) { onMsg(err instanceof Error ? err.message : "failed"); }
  }

  return (
    <section className="card">
      <h2 className="section-title"><IconShield size={15} className="text-down" /> Live trading gates</h2>
      <p className="mb-4 text-xs leading-relaxed text-ink-dim">
        These switches decide whether the bot may place <span className="font-medium text-down">REAL-MONEY</span> trades.
        They apply only when the terminal is on a real (non-demo) account — demo trading is never gated. Every gate
        here, plus the per-account live toggle above, must be open for a live order to go through.
      </p>
      <div className="space-y-3">
        <Toggle danger
          label="System live trading enabled"
          hint="Master switch. Off = no live orders, ever (demo unaffected)."
          checked={state.liveTradingEnabled} onChange={(v) => set({ liveTradingEnabled: v })} />
        <Toggle
          label="Require 2FA for live trades"
          hint="On: manual & approval live trades need a TOTP code. Off: live trades skip 2FA entirely."
          checked={state.requireLiveTwoFactor} onChange={(v) => set({ requireLiveTwoFactor: v })} />
        <Toggle danger
          label="Authorize automated live trading"
          hint="Standing consent so the autonomous bot can place live trades (it can't type a per-trade code). Only consulted while 2FA is required."
          checked={state.autoLiveAuthorized} onChange={(v) => set({ autoLiveAuthorized: v })} />
      </div>
      {state.requireLiveTwoFactor && !state.autoLiveAuthorized && (
        <p className="mt-3 text-xs text-warn">
          Heads up: with 2FA required and auto-authorization off, the autonomous bot cannot place live trades — only the manual button can.
        </p>
      )}
      <button onClick={save} className="btn-primary mt-4">Save live-trading settings</button>
    </section>
  );
}

function ScannerSettings({ onMsg }: { onMsg: (m: string) => void }) {
  const [cfg, setCfg] = useState<{ enabled: boolean; symbols: string[]; intervalMin: number; maxPerDay: number; minScore: number; aiMode: "STRICT" | "ADVISORY"; minAiConfidence: number } | null>(null);
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
        Sweeps the watchlist on its own. In Automatic mode it executes passing setups after AI and risk checks;
        in other modes it creates approval requests so you choose the lot size.
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
        <div>
          <label htmlFor="scanner-ai-mode" className="label">AI gate</label>
          <select id="scanner-ai-mode" className="input cursor-pointer" value={cfg.aiMode}
            onChange={(e) => setCfg({ ...cfg, aiMode: e.target.value as "STRICT" | "ADVISORY" })}>
            <option value="STRICT">Strict</option>
            <option value="ADVISORY">Advisory</option>
          </select>
        </div>
        <div>
          <label htmlFor="scanner-ai-confidence" className="label">Min AI confidence</label>
          <input id="scanner-ai-confidence" className="input tnum" type="number" min={0} max={1} step={0.05} value={cfg.minAiConfidence}
            onChange={(e) => setCfg({ ...cfg, minAiConfidence: Number(e.target.value) })} />
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
