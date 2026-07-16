"use client";
import { useCallback, useEffect, useState } from "react";
import { API_URL, api, setToken } from "@/lib/api";
import { buildLiveTradingRequestBody } from "@/lib/live-settings";
import { IconLogout, IconShield } from "@/components/icons";
import { AiProviderSwitch } from "@/components/AiProviderSwitch";
import { ScalpingSettingsPanel } from "@/components/ScalpingSettingsPanel";
import { AssistantSettings } from "@/components/AssistantSettings";
import { useToast, type ToastReporter } from "@/components/ToastProvider";

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
  const { show: showToast } = useToast();
  const [risk, setRisk] = useState<Risk>({});
  const report = useCallback<ToastReporter>((message, tone = "success") => {
    if (!message) return;
    showToast({
      tone,
      title: tone === "error" ? "Update failed" : tone === "warning" ? "Attention required" : tone === "info" ? "Settings information" : "Settings updated",
      description: message,
    });
  }, [showToast]);

  const load = useCallback(async () => {
    try { setRisk(await api<Risk>("/api/risk-settings")); } catch { /* noop */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    try {
      const { id, userId, ...payload } = risk;
      await api("/api/risk-settings", { method: "PUT", body: payload });
      report("Risk settings saved.");
    } catch (err) { report(err instanceof Error ? err.message : "Risk settings could not be saved.", "error"); }
  }

  return (
    <div className="space-y-6">
      <AccountSection onMsg={report} />

      <LiveTradingSettings onMsg={report} />

      <AiProviderSwitch />

      <AssistantSettings onMsg={report} />

      <OperationalSettings onMsg={report} />

      <section className="card">
        <h2 className="section-title"><IconShield size={15} className="text-primary" /> Risk settings</h2>
        <p className="mb-4 text-xs leading-relaxed text-ink-dim">Every value below is loaded from and saved to PostgreSQL. The application does not silently apply a fixed risk preset.</p>
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

      <ScannerSettings onMsg={report} />

      <ScalpingSettingsPanel onMsg={report} />

      <ConnectorSettings onMsg={report} />

      <section className="card">
        <button onClick={() => { setToken(null); window.location.href = "/login"; }} className="btn-ghost">
          <IconLogout size={15} /> Sign out
        </button>
      </section>

    </div>
  );
}

interface TelegramStatus {
  configured: boolean;
  bot: { username: string; displayName: string } | null;
  linked: boolean;
  telegramId: string | null;
  pendingCode: string | null;
}
interface TelegramLink { code: string; deepLink: string; instructions: string; bot: { username: string; displayName: string }; }

function ConnectorSettings({ onMsg }: { onMsg: ToastReporter }) {
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [telegramLink, setTelegramLink] = useState<TelegramLink | null>(null);
  const [whatsappInstructions, setWhatsappInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const loadTelegram = useCallback(async () => {
    try { setTelegram(await api<TelegramStatus>("/auth/link/telegram/status")); }
    catch (error) { onMsg(error instanceof Error ? error.message : "Could not check Telegram status.", "error"); }
  }, [onMsg]);
  useEffect(() => { void loadTelegram(); }, [loadTelegram]);

  async function createTelegramLink() {
    setBusy(true); onMsg("");
    try { const result = await api<TelegramLink>("/auth/link/telegram", { method: "POST" }); setTelegramLink(result); await loadTelegram(); }
    catch (error) { onMsg(error instanceof Error ? error.message : "Could not create Telegram link.", "error"); }
    finally { setBusy(false); }
  }

  async function createWhatsappLink() {
    setBusy(true); onMsg("");
    try { const result = await api<{ instructions: string }>("/auth/link/whatsapp", { method: "POST" }); setWhatsappInstructions(result.instructions); }
    catch (error) { onMsg(error instanceof Error ? error.message : "Could not create WhatsApp link.", "error"); }
    finally { setBusy(false); }
  }

  const pendingCode = telegramLink?.code ?? telegram?.pendingCode;
  const username = telegramLink?.bot.username ?? telegram?.bot?.username;
  const deepLink = telegramLink?.deepLink ?? (pendingCode && username ? `https://t.me/${username}?start=link_${pendingCode}` : null);

  return <section className="card">
    <h2 className="section-title">Messaging connectors</h2>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-sky-900/70 bg-sky-950/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-medium text-sky-200">Telegram</h3><p className="text-xs text-ink-faint">Use the assistant and receive trading notifications.</p></div><span className={`chip ${telegram?.linked ? "bg-emerald-950 text-up" : telegram?.configured ? "bg-sky-950 text-sky-300" : "bg-red-950 text-down"}`}>{telegram?.linked ? "Linked" : telegram?.configured ? "Bot online" : "Not configured"}</span></div>
        {telegram?.bot && <p className="mt-3 text-sm text-ink-dim">Configured bot: <a className="font-semibold text-sky-300 hover:underline" href={`https://t.me/${telegram.bot.username}`} target="_blank" rel="noreferrer">@{telegram.bot.username}</a></p>}
        {telegram?.linked ? <div className="mt-3 rounded-lg bg-emerald-950/40 p-3 text-sm text-emerald-200">Connected successfully. Send <code>/status</code> or <code>/ask what is happening?</code> to the bot.</div> : <>
          {pendingCode && <div className="mt-3 rounded-lg bg-bg p-3"><p className="text-xs text-ink-faint">Your active link command</p><code className="tnum mt-1 block text-sm text-warn">/link {pendingCode}</code><p className="mt-2 text-xs text-ink-dim">Send this exact command to @{username}. Generating another code invalidates this one.</p></div>}
          <div className="mt-3 flex flex-wrap gap-2">{deepLink && <a className="btn bg-sky-900 text-sky-100 hover:bg-sky-800" href={deepLink} target="_blank" rel="noreferrer">Open Telegram and connect</a>}<button type="button" disabled={busy || !telegram?.configured} onClick={() => void createTelegramLink()} className="btn-ghost">{pendingCode ? "Generate fresh code" : "Create connection link"}</button></div>
        </>}
        <button type="button" disabled={busy} onClick={() => void loadTelegram()} className="mt-3 text-xs text-sky-300 hover:underline">Check connection status</button>
        {telegram && !telegram.configured && <p className="mt-2 text-xs text-down">Save a valid Telegram bot token in Operational configuration, then restart the backend once so polling can start.</p>}
      </div>
      <div className="rounded-xl border border-emerald-900/70 bg-emerald-950/20 p-4">
        <h3 className="font-medium text-emerald-200">WhatsApp</h3><p className="text-xs text-ink-faint">Link the Twilio WhatsApp number configured below.</p>
        <button type="button" disabled={busy} onClick={() => void createWhatsappLink()} className="btn mt-3 bg-emerald-900 text-emerald-100 hover:bg-emerald-800">Create WhatsApp link</button>
        {whatsappInstructions && <p className="tnum mt-3 rounded-lg bg-bg p-3 font-mono text-sm text-warn">{whatsappInstructions}</p>}
      </div>
    </div>
  </section>;
}

type Operational = {
  strategyValidationApproved: boolean;
  mt5BridgeUrl: string;
  newsCalendarUrl: string;
  newsRefreshMinutes: number;
  newsRssFeeds: string[];
  aiRequestTimeoutMs: number;
  aiResearchFallbackToOllama: boolean;
  tradingMemoryEnabled: boolean;
  tradingMemoryLookbackTrades: number;
  tradingMemoryMinSamples: number;
  intelligenceApprovalMode: "manual" | "ai";
  intelligenceAiApprovalMinConfidence: number;
  telegramAllowedIds: string[];
  twilioWhatsappFrom: string;
  webSearchProvider: "tavily" | "serper";
  hasMt5BridgeApiKey: boolean;
  hasTelegramBotToken: boolean;
  hasTwilioAccountSid: boolean;
  hasTwilioAuthToken: boolean;
  hasWebSearchApiKey: boolean;
  hasYoutubeApiKey: boolean;
  hasGithubToken: boolean;
  hasXBearerToken: boolean;
  mcpEnabled: boolean;
  mcpAllowMutations: boolean;
  mcpAllowTradingActions: boolean;
  mcpAllowedOrigins: string[];
  hasMcpAccessToken: boolean;
  mcpTokenCreatedAt: string | null;
  strategyAnalysisIntervalMs: number;
  protectionIntervalMs: number;
  floatingPnlIntervalMs: number;
  strategyLabIntervalHours: number;
  intelligencePollIntervalMin: number;
  intelligenceMaintenanceIntervalHours: number;
  scalpingFireIntervalMs: number;
  scalpingAiRefreshIntervalMs: number;
  scalpingEntryLeaseMs: number;
  scalpingBlockAuditThrottleMs: number;
  tradeApprovalTtlMin: number;
  assistantConfirmationTtlMin: number;
  paperTradeStaleTickMin: number;
  paperExpectedSlippagePoints: number;
  paperCommissionPerLot: number;
  notificationHistoryLimit: number;
};

function OperationalSettings({ onMsg }: { onMsg: ToastReporter }) {
  const [cfg, setCfg] = useState<Operational | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try { setCfg(await api<Operational>("/api/system/operational-settings")); } catch { /* role/API not ready */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!cfg) return null;

  const secretField = (key: string, label: string, present: boolean) => (
    <div>
      <label htmlFor={`ops-${key}`} className="label">{label} {present ? <span className="text-up">(configured)</span> : <span className="text-ink-faint">(not set)</span>}</label>
      <input id={`ops-${key}`} type="password" autoComplete="off" className="input" placeholder="Leave blank to keep current value"
        value={secrets[key] ?? ""} onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })} />
      {present && <label className="mt-1 flex items-center gap-2 text-xs text-ink-faint"><input type="checkbox" checked={Boolean(clear[key])} onChange={(e) => setClear({ ...clear, [key]: e.target.checked })} /> Clear saved value</label>}
    </div>
  );

  async function save() {
    if (!cfg) return;
    try {
      const payload = {
        ...cfg,
        newsRssFeeds: cfg.newsRssFeeds,
        telegramAllowedIds: cfg.telegramAllowedIds,
        ...secrets,
        clearMt5BridgeApiKey: clear.mt5BridgeApiKey,
        clearTelegramBotToken: clear.telegramBotToken,
        clearTwilioAccountSid: clear.twilioAccountSid,
        clearTwilioAuthToken: clear.twilioAuthToken,
        clearWebSearchApiKey: clear.webSearchApiKey,
        clearYoutubeApiKey: clear.youtubeApiKey,
        clearGithubToken: clear.githubToken,
        clearXBearerToken: clear.xBearerToken,
      };
      const next = await api<Operational>("/api/system/operational-settings", { method: "PUT", body: payload });
      setCfg(next); setSecrets({}); setClear({});
      onMsg("Operational settings saved. Secrets are encrypted and never returned to the browser.");
    } catch (err) { onMsg(err instanceof Error ? err.message : "Operational settings could not be saved.", "error"); }
  }

  return (
    <section className="card">
      <h2 className="section-title">Operational configuration</h2>
      <p className="mb-4 text-xs leading-relaxed text-ink-dim">These are global runtime settings stored in the database. Changes take effect without editing an environment file. Bootstrap secrets used to reach and protect the database are deliberately not shown here.</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div><label htmlFor="ops-bridge-url" className="label">MT5 bridge URL</label><input id="ops-bridge-url" className="input" value={cfg.mt5BridgeUrl} onChange={(e) => setCfg({ ...cfg, mt5BridgeUrl: e.target.value })} /></div>
        {secretField("mt5BridgeApiKey", "MT5 bridge API key", cfg.hasMt5BridgeApiKey)}
        <div><label htmlFor="ops-calendar" className="label">Economic-calendar URL</label><input id="ops-calendar" className="input" value={cfg.newsCalendarUrl} onChange={(e) => setCfg({ ...cfg, newsCalendarUrl: e.target.value })} /></div>
        <div><label htmlFor="ops-refresh" className="label">News refresh (minutes)</label><input id="ops-refresh" type="number" min={1} max={1440} className="input" value={cfg.newsRefreshMinutes} onChange={(e) => setCfg({ ...cfg, newsRefreshMinutes: Number(e.target.value) })} /></div>
        <div><label htmlFor="ops-rss" className="label">RSS feed URLs (comma-separated)</label><input id="ops-rss" className="input" value={cfg.newsRssFeeds.join(", ")} onChange={(e) => setCfg({ ...cfg, newsRssFeeds: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /></div>
        <div><label htmlFor="ops-ai-timeout" className="label">AI request timeout (ms)</label><input id="ops-ai-timeout" type="number" min={1000} max={180000} className="input" value={cfg.aiRequestTimeoutMs} onChange={(e) => setCfg({ ...cfg, aiRequestTimeoutMs: Number(e.target.value) })} /></div>
        <div><label htmlFor="ops-intelligence-approval" className="label">Knowledge approval mode</label><select id="ops-intelligence-approval" className="input" value={cfg.intelligenceApprovalMode} onChange={(e) => setCfg({ ...cfg, intelligenceApprovalMode: e.target.value as Operational["intelligenceApprovalMode"] })}><option value="manual">Manual review</option><option value="ai">AI automatic review</option></select><p className="mt-1 text-xs text-ink-faint">Controls long-term research knowledge only. It never authorizes trades or source licences.</p></div>
        {cfg.intelligenceApprovalMode === "ai" && <div><label htmlFor="ops-intelligence-confidence" className="label">AI approval confidence ({Math.round(cfg.intelligenceAiApprovalMinConfidence * 100)}%)</label><input id="ops-intelligence-confidence" type="range" min={0.5} max={0.99} step={0.01} className="w-full" value={cfg.intelligenceAiApprovalMinConfidence} onChange={(e) => setCfg({ ...cfg, intelligenceAiApprovalMinConfidence: Number(e.target.value) })} /><p className="mt-1 text-xs text-ink-faint">Below this threshold the AI defers the decision instead of approving or rejecting it.</p></div>}
        <div><label htmlFor="ops-tg-ids" className="label">Telegram allowed IDs (comma-separated)</label><input id="ops-tg-ids" className="input" value={cfg.telegramAllowedIds.join(", ")} onChange={(e) => setCfg({ ...cfg, telegramAllowedIds: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /></div>
        {secretField("telegramBotToken", "Telegram bot token", cfg.hasTelegramBotToken)}
        <div><label htmlFor="ops-wa-from" className="label">Twilio WhatsApp sender</label><input id="ops-wa-from" className="input" value={cfg.twilioWhatsappFrom} onChange={(e) => setCfg({ ...cfg, twilioWhatsappFrom: e.target.value })} /></div>
        {secretField("twilioAccountSid", "Twilio account SID", cfg.hasTwilioAccountSid)}
        {secretField("twilioAuthToken", "Twilio auth token", cfg.hasTwilioAuthToken)}
        <div><label htmlFor="ops-search-provider" className="label">Web-search provider</label><select id="ops-search-provider" className="input" value={cfg.webSearchProvider} onChange={(e) => setCfg({ ...cfg, webSearchProvider: e.target.value as Operational["webSearchProvider"] })}><option value="tavily">Tavily</option><option value="serper">Serper</option></select></div>
        {secretField("webSearchApiKey", "Web-search API key", cfg.hasWebSearchApiKey)}
        {secretField("youtubeApiKey", "YouTube Data API key", cfg.hasYoutubeApiKey)}
        {secretField("githubToken", "GitHub token (optional)", cfg.hasGithubToken)}
        {secretField("xBearerToken", "X API bearer token", cfg.hasXBearerToken)}
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Toggle danger label="Strategy validation approved" hint="Leave off until the documented out-of-sample and paper-trading gates have passed." checked={cfg.strategyValidationApproved} onChange={(v) => setCfg({ ...cfg, strategyValidationApproved: v })} />
        <Toggle label="AI research fallback to Ollama" hint="Allow research-only fallback when the selected provider is unavailable." checked={cfg.aiResearchFallbackToOllama} onChange={(v) => setCfg({ ...cfg, aiResearchFallbackToOllama: v })} />
      </div>
      <div className="mt-5 rounded-2xl border border-line bg-surface-2 p-4">
        <h3 className="text-sm font-semibold text-ink">Runtime timing and execution values</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">These values are read from the database by the live workers. Updated cadences take effect on the next scheduled cycle without editing an environment file.</p>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {([
            ["strategyAnalysisIntervalMs", "Strategy analysis interval (ms)", 250],
            ["protectionIntervalMs", "Protection interval (ms)", 250],
            ["floatingPnlIntervalMs", "Floating P/L interval (ms)", 250],
            ["strategyLabIntervalHours", "Strategy Lab interval (hours)", 0.01],
            ["intelligencePollIntervalMin", "Research polling (minutes)", 0.01],
            ["intelligenceMaintenanceIntervalHours", "Research maintenance (hours)", 0.01],
            ["scalpingFireIntervalMs", "Scalping fire interval (ms)", 100],
            ["scalpingAiRefreshIntervalMs", "Scalping AI refresh (ms)", 250],
            ["scalpingEntryLeaseMs", "Scalping entry lease (ms)", 250],
            ["scalpingBlockAuditThrottleMs", "Scalping audit throttle (ms)", 0],
            ["tradeApprovalTtlMin", "Trade approval expiry (min)", 0.01],
            ["assistantConfirmationTtlMin", "Assistant approval expiry (min)", 0.01],
            ["paperTradeStaleTickMin", "Paper stale-tick limit (min)", 0.01],
            ["paperExpectedSlippagePoints", "Paper slippage (points)", 0],
            ["paperCommissionPerLot", "Paper commission per lot", 0],
            ["notificationHistoryLimit", "Notification history size", 1],
          ] as const).map(([key, label, min]) => <label key={key}><span className="label">{label}</span><input className="input tnum" type="number" min={min} step={min >= 1 ? 1 : 0.01} value={cfg[key]} onChange={(event) => setCfg({ ...cfg, [key]: Number(event.target.value) })} /></label>)}
        </div>
      </div>
      <TradingMemoryPanel cfg={cfg} setCfg={setCfg} onMsg={onMsg} />
      <McpAccessPanel cfg={cfg} setCfg={setCfg} reload={load} onMsg={onMsg} />
      <button onClick={save} className="btn-primary mt-4">Save operational settings</button>
    </section>
  );
}

interface TradingMemorySummary {
  total: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  totalProfit: number;
  symbols: { symbol: string; trades: number; wins: number; profit: number; winRate: number }[];
  recent: { id: string; symbol: string; direction: string; outcome: string; profit: number; lesson: string; createdAt: string }[];
}

function TradingMemoryPanel({ cfg, setCfg, onMsg }: {
  cfg: Operational;
  setCfg: (next: Operational) => void;
  onMsg: ToastReporter;
}) {
  const [summary, setSummary] = useState<TradingMemorySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setSummary(await api<TradingMemorySummary>("/api/trading-memory")); }
    catch { /* the operational form remains usable if memory stats are unavailable */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function rebuild() {
    setBusy(true);
    try {
      const result = await api<{ learned: number; summary: TradingMemorySummary }>("/api/trading-memory/rebuild", { method: "POST", body: { limit: 500 } });
      setSummary(result.summary);
      onMsg(result.learned ? `Learned from ${result.learned} completed trade${result.learned === 1 ? "" : "s"}.` : "Memory is current; no completed trades were missing.", "info");
    } catch (error) { onMsg(error instanceof Error ? error.message : "Could not rebuild trading memory.", "error"); }
    finally { setBusy(false); }
  }

  return <div className="mt-5 rounded-2xl border border-teal-900/60 bg-teal-950/15 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-teal-200">Persistent trading memory</h3><span className={`chip ${cfg.tradingMemoryEnabled ? "bg-emerald-950 text-up" : "bg-surface-3 text-ink-faint"}`}>{cfg.tradingMemoryEnabled ? "Learning" : "Paused"}</span></div>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-dim">Stores every completed trade outcome in PostgreSQL, identifies repeatable strengths and mistakes, and supplies only relevant lessons to future AI trade reviews. Memory may reduce confidence or size, but never overrides current market evidence or the risk engine.</p>
      </div>
      <button type="button" disabled={busy || !cfg.tradingMemoryEnabled} onClick={() => void rebuild()} className="btn-ghost btn-sm">{busy ? "Learning…" : "Learn from trade history"}</button>
    </div>
    <div className="mt-4 grid gap-3 md:grid-cols-3">
      <Toggle label="Enable persistent memory" hint="Learn automatically after each realized trade and retain lessons across restarts." checked={cfg.tradingMemoryEnabled} onChange={(value) => setCfg({ ...cfg, tradingMemoryEnabled: value })} />
      <label><span className="label">Memory lookback (trades)</span><input type="number" min={20} max={1000} className="input" value={cfg.tradingMemoryLookbackTrades} onChange={(event) => setCfg({ ...cfg, tradingMemoryLookbackTrades: Number(event.target.value) })} /><span className="mt-1 block text-xs text-ink-faint">Maximum recent outcomes considered for a new decision.</span></label>
      <label><span className="label">Minimum relevant samples</span><input type="number" min={2} max={50} className="input" value={cfg.tradingMemoryMinSamples} onChange={(event) => setCfg({ ...cfg, tradingMemoryMinSamples: Number(event.target.value) })} /><span className="mt-1 block text-xs text-ink-faint">Below this count, memory reports insufficient evidence instead of claiming an edge.</span></label>
    </div>
    {summary && <>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MemoryStat label="Learned trades" value={String(summary.total)} />
        <MemoryStat label="Win rate" value={summary.winRate === null ? "—" : `${Math.round(summary.winRate * 100)}%`} />
        <MemoryStat label="Wins / losses" value={`${summary.wins} / ${summary.losses}`} />
        <MemoryStat label="Remembered P/L" value={`${summary.totalProfit >= 0 ? "+" : ""}${summary.totalProfit.toFixed(2)}`} />
      </div>
      {summary.recent.length > 0 && <div className="mt-3 space-y-2"><p className="text-xs font-medium text-ink-dim">Latest lessons</p>{summary.recent.slice(0, 3).map((item) => <div key={item.id} className="rounded-xl bg-bg px-3 py-2 text-xs"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium text-ink">{item.symbol} {item.direction.toLowerCase()}</span><span className={item.outcome === "WIN" ? "text-up" : item.outcome === "LOSS" ? "text-down" : "text-ink-faint"}>{item.outcome} · {item.profit >= 0 ? "+" : ""}{item.profit.toFixed(2)}</span></div><p className="mt-1 leading-relaxed text-ink-dim">{item.lesson}</p></div>)}</div>}
    </>}
    <p className="mt-3 text-xs text-warn">Save operational settings after changing memory controls. Pausing memory does not delete previously learned lessons.</p>
  </div>;
}

function MemoryStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-bg p-3"><p className="text-[11px] text-ink-faint">{label}</p><p className="tnum mt-1 text-base font-semibold text-ink">{value}</p></div>;
}

function McpAccessPanel({ cfg, setCfg, reload, onMsg }: {
  cfg: Operational;
  setCfg: (next: Operational) => void;
  reload: () => Promise<void>;
  onMsg: ToastReporter;
}) {
  const [token, setAccessToken] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `${API_URL.replace(/\/$/, "")}/mcp`;
  const clientConfig = JSON.stringify({
    mcpServers: {
      mt5bot: {
        type: "http",
        url: endpoint,
        headers: { Authorization: `Bearer ${token || "<YOUR_MCP_TOKEN>"}` },
      },
    },
  }, null, 2);

  async function rotateToken() {
    if (cfg.hasMcpAccessToken && !confirm("Rotate the MCP access token? Existing AI clients will immediately lose access until you update them with the new token.")) return;
    setBusy(true);
    try {
      const generated = await api<{ token: string; createdAt: string }>("/api/system/mcp-token", { method: "POST", body: {} });
      setAccessToken(generated.token);
      await reload();
      onMsg("A new MCP token was generated. Copy it now; it will not be displayed again.", "warning");
    } catch (error) { onMsg(error instanceof Error ? error.message : "Could not generate MCP access.", "error"); }
    finally { setBusy(false); }
  }

  async function revokeToken() {
    if (!confirm("Revoke MCP access? Every connected AI client will immediately stop working.")) return;
    setBusy(true);
    try {
      await api("/api/system/mcp-token", { method: "DELETE" });
      setAccessToken("");
      await reload();
      onMsg("MCP access was revoked.");
    } catch (error) { onMsg(error instanceof Error ? error.message : "Could not revoke MCP access.", "error"); }
    finally { setBusy(false); }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      onMsg(`${label} copied to the clipboard.`, "info");
    } catch { onMsg("Clipboard access was blocked. Select and copy the value manually.", "warning"); }
  }

  return (
    <div className="mt-5 rounded-2xl border border-violet-900/60 bg-violet-950/15 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-violet-200">MCP agent access</h3><span className={`chip ${cfg.mcpEnabled && cfg.hasMcpAccessToken ? "bg-emerald-950 text-up" : "bg-surface-3 text-ink-faint"}`}>{cfg.mcpEnabled && cfg.hasMcpAccessToken ? "Ready" : "Off"}</span></div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-dim">Connect Claude Code, ChatGPT, Hermes, Codex, or another MCP-compatible agent to the full system context. Read access is the safe default; mutations and trading actions require separate switches and explicit per-call confirmations.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void rotateToken()} className="btn-primary btn-sm">{cfg.hasMcpAccessToken ? "Rotate token" : "Generate token"}</button>
          {cfg.hasMcpAccessToken && <button type="button" disabled={busy} onClick={() => void revokeToken()} className="btn-danger btn-sm">Revoke</button>}
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <Toggle label="Enable MCP server" hint="Allow authenticated clients to connect to /mcp." checked={cfg.mcpEnabled} onChange={(value) => setCfg({ ...cfg, mcpEnabled: value })} />
        <Toggle danger label="Allow system mutations" hint="Permit confirmed changes such as pausing the bot or disabling a strategy." checked={cfg.mcpAllowMutations} onChange={(value) => setCfg({ ...cfg, mcpAllowMutations: value, ...(value ? {} : { mcpAllowTradingActions: false }) })} />
        <Toggle danger label="Allow trading actions" hint="Permit confirmed actions that can affect live trading, risk limits, scans, or strategy enablement." checked={cfg.mcpAllowTradingActions} onChange={(value) => setCfg({ ...cfg, mcpAllowTradingActions: value, ...(value ? { mcpAllowMutations: true } : {}) })} />
      </div>

      <label className="mt-3 block">
        <span className="label">Allowed browser origins (comma-separated)</span>
        <input className="input" value={cfg.mcpAllowedOrigins.join(", ")} placeholder="https://chatgpt.com, https://your-agent.example" onChange={(event) => setCfg({ ...cfg, mcpAllowedOrigins: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} />
        <span className="mt-1 block text-xs text-ink-faint">CLI and desktop clients normally send no browser Origin. Add only trusted web-agent origins here.</span>
      </label>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl bg-bg p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-ink-dim">Streamable HTTP endpoint</span><button type="button" onClick={() => void copy(endpoint, "MCP endpoint")} className="text-xs text-primary hover:underline">Copy</button></div>
          <code className="mt-2 block break-all text-xs text-ink">{endpoint}</code>
          <p className="mt-2 text-[11px] text-ink-faint">For an AI service outside this computer, expose the backend through a trusted HTTPS domain or private tunnel; localhost is accessible only on this Mac.</p>
        </div>
        <div className="rounded-xl bg-bg p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-ink-dim">Access token</span>{token && <button type="button" onClick={() => void copy(token, "MCP token")} className="text-xs text-primary hover:underline">Copy</button>}</div>
          <code className={`mt-2 block break-all text-xs ${token ? "text-warn" : "text-ink-faint"}`}>{token || (cfg.hasMcpAccessToken ? "Token configured — rotate it to reveal a new value" : "Generate a token to connect a client")}</code>
          {cfg.mcpTokenCreatedAt && <p className="mt-2 text-[11px] text-ink-faint">Created {new Date(cfg.mcpTokenCreatedAt).toLocaleString()}</p>}
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-bg p-3">
        <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-ink-dim">Generic MCP client configuration</span><button type="button" onClick={() => void copy(clientConfig, "Client configuration")} className="text-xs text-primary hover:underline">Copy</button></div>
        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-ink-faint">{clientConfig}</pre>
      </div>
      <p className="mt-3 text-xs text-warn">Save operational settings after changing permission switches or allowed origins. Token generation enables MCP automatically, but it does not enable mutation or trading permissions.</p>
    </div>
  );
}

interface AccountsData {
  saved: { id: string; label: string; login: string; server: string; isDemo: boolean; verified: boolean; hasCredentials: boolean }[];
  current: { login: string; balance: number; currency: string; is_demo: boolean } | null;
  activeAccountId: string | null;
  userLiveEnabled: boolean;
}

function AccountSection({ onMsg }: { onMsg: ToastReporter }) {
  const [data, setData] = useState<AccountsData | null>(null);
  const [form, setForm] = useState({ label: "", login: "", password: "", server: "" });
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try { setData(await api<AccountsData>("/api/mt5/accounts")); setLoadError(""); }
    catch (err) { setLoadError(err instanceof Error ? err.message : "Could not load MT5 accounts."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    const isLikelyReal = !form.server.toLowerCase().includes("demo");
    if (isLikelyReal && !confirm(
      `"${form.server}" does not look like a demo server.\n\nConnecting switches the WHOLE terminal to this account, and the bot will trade REAL MONEY on it once live trading is enabled.\n\nContinue?`,
    )) return;
    setBusy("connect");
    onMsg("");
    try {
      const res = await api<{ ok: boolean; balance?: number; currency?: string; account: { isDemo: boolean } }>("/api/mt5/connect", {
        method: "POST",
        body: { label: form.label || `${form.login}@${form.server}`, login: form.login, password: form.password, server: form.server },
      });
      onMsg(`Connected: ${form.login} on ${form.server} (${res.account.isDemo ? "DEMO" : "REAL"}) — balance ${res.balance?.toFixed(2)} ${res.currency ?? ""}.`);
      setForm({ label: "", login: "", password: "", server: "" });
      setShowConnectForm(false);
      await load();
    } catch (err) {
      onMsg(err instanceof Error ? err.message : "Connection failed.", "error");
    } finally { setBusy(null); }
  }

  async function reconnect(account: AccountsData["saved"][number]) {
    if (!account.hasCredentials) {
      setForm({ label: account.label, login: account.login, server: account.server, password: "" });
      setShowConnectForm(true);
      onMsg(`Add the password for ${account.label}, then select Switch account to save credentials and connect it.`, "info");
      return;
    }
    setBusy(`reconnect:${account.id}`);
    onMsg("");
    try {
      const res = await api<{ ok: boolean; login: string; isDemo: boolean }>(`/api/mt5/accounts/${account.id}/reconnect`, { method: "POST" });
      onMsg(`Reconnected to ${res.login} (${res.isDemo ? "DEMO" : "REAL"}).`);
      await load();
    } catch (err) { onMsg(err instanceof Error ? err.message : "Reconnect failed.", "error"); }
    finally { setBusy(null); }
  }

  function editAccount(account: AccountsData["saved"][number]) {
    setForm({ label: account.label, login: account.login, server: account.server, password: "" });
    setShowConnectForm(true);
    onMsg(`Update ${account.label}: enter its password, then select Switch account. Your saved account details will be updated.`, "info");
  }

  async function removeAccount(account: AccountsData["saved"][number]) {
    if (account.id === data?.activeAccountId) {
      onMsg("Switch the MT5 terminal to another account before removing the active account.", "warning");
      return;
    }
    if (!confirm(
      `Remove ${account.label} (${account.login})?\n\nThe account will disappear from the saved list and its stored password will be erased. Historical trades will be kept.`,
    )) return;
    setBusy(`remove:${account.id}`);
    onMsg("");
    try {
      await api(`/api/mt5/accounts/${account.id}`, { method: "DELETE" });
      onMsg(`${account.label} was removed. Its historical trades were kept.`);
      await load();
    } catch (err) { onMsg(err instanceof Error ? err.message : "Account removal failed.", "error"); }
    finally { setBusy(null); }
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
    } catch (err) { onMsg(err instanceof Error ? err.message : "Live trading could not be updated.", "error"); }
  }

  return (
    <section className="card">
      <h2 className="section-title">MT5 account & live trading</h2>

      {loadError && <p className="mb-3 text-sm text-down">{loadError}</p>}

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

      {data?.current && !showConnectForm && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
          <span className="text-ink-dim">The active terminal account was detected automatically.</span>
          <button onClick={() => setShowConnectForm(true)} className="btn-ghost btn-sm">Add or switch account</button>
        </div>
      )}

      {(!data?.current || showConnectForm) && <form onSubmit={connect} className="grid grid-cols-2 items-end gap-3 lg:grid-cols-5">
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
        <div className="flex gap-2">
          <button disabled={busy !== null} className="btn-primary">{busy === "connect" ? "Connecting…" : "Switch account"}</button>
          {data?.current && <button type="button" onClick={() => setShowConnectForm(false)} className="btn-ghost">Cancel</button>}
        </div>
      </form>}
      {(!data?.current || showConnectForm) && <p className="mt-2 text-xs text-ink-faint">
        Switching changes the account for the whole terminal. Credentials are encrypted at rest and never logged.
      </p>}

      {data && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-ink">Saved accounts</h3>
              <p className="mt-0.5 text-xs text-ink-faint">Removing an account clears its saved password but keeps its trade history.</p>
            </div>
            <button onClick={() => void load()} disabled={busy !== null} className="btn-ghost btn-sm">Refresh</button>
          </div>
          {data.saved.length === 0 && <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-dim">No accounts saved yet. Connect an account above to add it here.</p>}
          <div className="space-y-2">
          {data.saved.map((a) => (
            <div key={a.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${a.id === data.activeAccountId ? "border-primary/60 bg-primary-dim/10" : "border-line bg-surface-2"}`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`chip !text-[10px] ${a.isDemo ? "bg-emerald-950 text-up" : "bg-red-950 text-down"}`}>{a.isDemo ? "DEMO" : "REAL"}</span>
                  {a.id === data.activeAccountId && <span className="chip bg-emerald-950 text-up">active terminal account</span>}
                  <span className="font-medium">{a.label}</span>
                </div>
                <p className="mt-1 tnum text-xs text-ink-faint">{a.login} · {a.server}</p>
                <p className={`mt-1 text-xs ${a.hasCredentials ? "text-ink-faint" : "text-warn"}`}>
                  {a.hasCredentials ? "Credentials saved securely — reconnect is available." : "Password not saved — add it before this account can reconnect."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => editAccount(a)} disabled={busy !== null} className="btn-ghost btn-sm">Edit</button>
                <button onClick={() => void reconnect(a)} disabled={busy !== null || a.id === data.activeAccountId} className="btn-primary btn-sm">
                  {busy === `reconnect:${a.id}` ? "Reconnecting…" : a.hasCredentials ? "Reconnect" : "Add password"}
                </button>
                <button
                  onClick={() => void removeAccount(a)}
                  disabled={busy !== null || a.id === data.activeAccountId}
                  title={a.id === data.activeAccountId ? "Switch accounts before removing the active terminal account" : "Remove saved account"}
                  className="btn-ghost btn-sm text-down"
                >
                  {busy === `remove:${a.id}` ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          ))}
          </div>
        </div>
      )}
    </section>
  );
}

interface LiveState {
  liveTradingEnabled: boolean;
  requireLiveTwoFactor: boolean;
  autoLiveAuthorized: boolean;
  adaptiveRiskEnabled: boolean;
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

function LiveTradingSettings({ onMsg }: { onMsg: ToastReporter }) {
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
          adaptiveRiskEnabled: state.adaptiveRiskEnabled,
        },
      });
      setState(next);
      onMsg("Live-trading settings saved.");
    } catch (err) { onMsg(err instanceof Error ? err.message : "Live-trading settings could not be saved.", "error"); }
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
        <Toggle
          label="Adaptive equity and AI sizing"
          hint="Automatically caps risk, lot size, open trades and daily trades by equity. The selected AI may reduce the calculated lot, but can never increase it above the safety cap."
          checked={state.adaptiveRiskEnabled} onChange={(v) => set({ adaptiveRiskEnabled: v })} />
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

function ScannerSettings({ onMsg }: { onMsg: ToastReporter }) {
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
      onMsg(err instanceof Error ? err.message : "Scanner settings could not be saved.", "error");
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
