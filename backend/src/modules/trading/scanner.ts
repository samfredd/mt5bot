import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { accountIdForLogin } from "../mt5/account.js";
import { buildMarketAnalysis, type MarketAnalysis } from "../analysis/engine.js";
import { assessNewsRisk } from "../news/service.js";
import { askModel } from "../ai/service.js";
import { buildTradePrompt } from "../ai/prompts.js";
import { calculateLots, validateTrade, type TradeProposal } from "../risk/engine.js";
import { buildRiskContext, sessionNow } from "./service.js";
import { getBotState } from "../system/state.js";
import { notify } from "../notifications/service.js";
import { broadcast } from "../ws/hub.js";

/**
 * Autonomous market scanner: sweeps a watchlist on its own (no strategy
 * config needed), ranks every symbol by technical confluence, has the AI
 * vet the best candidate, risk-checks it, and creates an APPROVAL REQUEST.
 *
 * The scanner NEVER executes — the human decides, and chooses the lot size
 * at approval time. That holds in every mode, including AUTO.
 */

export interface ScannerConfig {
  enabled: boolean;
  symbols: string[];
  intervalMin: number;
  maxPerDay: number;
  minScore: number;
}

const DEFAULTS: ScannerConfig = {
  enabled: true,
  symbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "XAUUSD"],
  intervalMin: 10,
  maxPerDay: 8,
  minScore: 4,
};

export async function getScannerConfig(): Promise<ScannerConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: "scanner" } });
  return { ...DEFAULTS, ...((row?.value as Partial<ScannerConfig>) ?? {}) };
}

export async function setScannerConfig(patch: Partial<ScannerConfig>, actor: string): Promise<ScannerConfig> {
  const next = { ...(await getScannerConfig()), ...patch };
  await prisma.systemSetting.upsert({
    where: { key: "scanner" },
    create: { key: "scanner", value: next as object },
    update: { value: next as object },
  });
  await audit({ actor, category: "system", action: "scanner_config_updated", detail: { patch } });
  return next;
}

interface Candidate {
  symbol: string;
  direction: "buy" | "sell";
  score: number;
  reasons: string[];
  analysis: MarketAnalysis;
}

/** Confluence scoring across timeframes — same discipline as the strategy engine. */
export function scoreSymbol(analysis: MarketAnalysis): { direction: "buy" | "sell" | null; score: number; reasons: string[] } {
  const reasons: string[] = [];
  const primary = analysis.timeframes.find((t) => t.timeframe === "H1") ?? analysis.timeframes[0];
  const higher = analysis.timeframes[analysis.timeframes.length - 1];
  if (!primary) return { direction: null, score: 0, reasons: ["no data"] };

  let bull = 0;
  let bear = 0;
  if (primary.trend === "bullish") { bull++; reasons.push(`${primary.timeframe} trend bullish`); }
  if (primary.trend === "bearish") { bear++; reasons.push(`${primary.timeframe} trend bearish`); }
  if (higher && higher !== primary) {
    if (higher.trend === "bullish") { bull++; reasons.push(`${higher.timeframe} confirms bullish`); }
    if (higher.trend === "bearish") { bear++; reasons.push(`${higher.timeframe} confirms bearish`); }
  }
  if (primary.structure === "higher_highs") { bull++; reasons.push("structure: higher highs/lows"); }
  if (primary.structure === "lower_lows") { bear++; reasons.push("structure: lower highs/lows"); }
  if (primary.rsi !== null) {
    if (primary.rsi <= 32) { bull++; reasons.push(`RSI oversold (${primary.rsi.toFixed(1)})`); }
    if (primary.rsi >= 68) { bear++; reasons.push(`RSI overbought (${primary.rsi.toFixed(1)})`); }
  }
  if (primary.macdHistogram !== null) {
    if (primary.macdHistogram > 0) { bull++; reasons.push("MACD positive"); }
    if (primary.macdHistogram < 0) { bear++; reasons.push("MACD negative"); }
  }
  if (primary.candlePattern) {
    if (["hammer", "bullish_engulfing"].includes(primary.candlePattern)) { bull++; reasons.push(`pattern: ${primary.candlePattern}`); }
    if (["shooting_star", "bearish_engulfing"].includes(primary.candlePattern)) { bear++; reasons.push(`pattern: ${primary.candlePattern}`); }
  }

  let direction: "buy" | "sell" | null = null;
  let score = 0;
  if (bull > bear) { direction = "buy"; score = bull; }
  else if (bear > bull) { direction = "sell"; score = bear; }
  reasons.push(`confluence — bull ${bull}, bear ${bear}`);

  // Anti-chasing: stand aside when price is stretched from its mean.
  if (direction && primary.emaFast !== null && primary.atr && primary.lastClose !== null) {
    const ext = (primary.lastClose - primary.emaFast) / primary.atr;
    if ((direction === "buy" && ext > 1.5) || (direction === "sell" && ext < -1.5)) {
      reasons.push(`over-extended ${Math.abs(ext).toFixed(1)} ATR from EMA20 — waiting for pullback`);
      direction = null;
    }
  }
  return { direction, score, reasons };
}

export interface ScanResult {
  scanned: number;
  candidates: { symbol: string; direction: string; score: number }[];
  suggested: { tradeId: string; symbol: string; direction: string; lots: number } | null;
  skippedReason?: string;
  /** Full scoring detail when the user directed a specific symbol. */
  directedAnalysis?: { symbol: string; direction: string | null; score: number; reasons: string[] };
}

export async function runScanner(
  trigger: "schedule" | "manual" = "schedule",
  opts: { symbol?: string } = {},
): Promise<ScanResult> {
  const empty: ScanResult = { scanned: 0, candidates: [], suggested: null };
  const directed = opts.symbol?.toUpperCase();
  const state = await getBotState();
  if (state.emergencyStop || state.status !== "running") {
    return { ...empty, skippedReason: `bot is ${state.emergencyStop ? "emergency-stopped" : state.status}` };
  }
  const cfg = await getScannerConfig();
  if (!cfg.enabled && trigger === "schedule") return { ...empty, skippedReason: "scanner disabled" };

  const user = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  const settings = user && (await prisma.riskSettings.findUnique({ where: { userId: user.id } }));
  if (!user || !settings) return { ...empty, skippedReason: "no admin user / risk settings" };

  // Daily cap applies to the autonomous sweep, not to explicit user requests.
  if (!directed) {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const suggestedToday = await prisma.trade.count({
      where: { userId: user.id, createdAt: { gte: dayStart }, explanation: { path: ["scanner"], equals: true } },
    });
    if (suggestedToday >= cfg.maxPerDay) return { ...empty, skippedReason: `daily suggestion cap reached (${cfg.maxPerDay})` };
  }

  // A directed request lowers the confluence bar to 2 (AI + risk still gate),
  // because the user explicitly asked for this symbol's best setup.
  const symbolsToScan = directed ? [directed] : cfg.symbols;
  const minScore = directed ? Math.min(cfg.minScore, 2) : cfg.minScore;
  let directedAnalysis: ScanResult["directedAnalysis"];

  // 1. Score the watchlist (or the single directed symbol)
  const candidates: Candidate[] = [];
  const fetchErrors: string[] = []; // symbols the bridge could not price
  for (const symbol of symbolsToScan) {
    try {
      const tick = await mt5.tick(symbol);
      const candlesByTf = {
        M15: await mt5.candles(symbol, "M15", 200),
        H1: await mt5.candles(symbol, "H1", 200),
        H4: await mt5.candles(symbol, "H4", 200),
      };
      const analysis = buildMarketAnalysis(symbol, tick, candlesByTf);
      const s = scoreSymbol(analysis);
      if (directed) directedAnalysis = { symbol, direction: s.direction, score: s.score, reasons: s.reasons };
      if (s.direction && s.score >= minScore) {
        candidates.push({ symbol, direction: s.direction, score: s.score, reasons: s.reasons, analysis });
      }
    } catch {
      fetchErrors.push(symbol);
      if (directed) return { ...empty, skippedReason: `could not fetch market data for ${symbol} — is the symbol name correct? (your broker may use a suffix, e.g. ${symbol}m)` };
    }
  }
  const summary = candidates.map((c) => ({ symbol: c.symbol, direction: c.direction, score: c.score }));
  broadcast("scanner", { trigger, scanned: symbolsToScan.length, candidates: summary, fetchErrors, directed });
  await audit({ actor: `scanner:${trigger}`, userId: user.id, category: "strategy", action: "market_scan", detail: { scanned: symbolsToScan.length, candidates: summary, fetchErrors, directed } });

  // Every symbol failed to price — this is a config/connectivity problem, not
  // "no setups". Surface it loudly instead of looking like an idle scan.
  if (fetchErrors.length === symbolsToScan.length) {
    return {
      scanned: symbolsToScan.length, candidates: [], suggested: null, directedAnalysis,
      skippedReason: `no market data for any watchlist symbol (${fetchErrors.join(", ")}). The bot can't see prices — check the symbol names match your broker (e.g. EURUSD vs EURUSDm) and that the bridge/terminal is connected.`,
    };
  }

  if (!candidates.length) {
    const errNote = fetchErrors.length ? ` (${fetchErrors.length} symbol(s) had no market data: ${fetchErrors.join(", ")})` : "";
    return {
      scanned: symbolsToScan.length, candidates: [], suggested: null, directedAnalysis,
      skippedReason: directed
        ? `no tradeable setup on ${directed} right now — ${directedAnalysis?.direction ? `direction ${directedAnalysis.direction} but confluence only ${directedAnalysis.score}` : "no clear direction"}`
        : `no setup met the confluence bar${errNote}`,
    };
  }

  // 2. Best candidate first; skip symbols that already have a pending suggestion
  candidates.sort((a, b) => b.score - a.score);
  for (const best of candidates) {
    const pending = await prisma.trade.findFirst({ where: { symbol: best.symbol, status: "PENDING_APPROVAL" } });
    if (pending) continue;

    const news = await assessNewsRisk(best.symbol, settings);
    if (news.action === "pause") continue;

    // 3. AI vetting
    const prompt = buildTradePrompt(
      best.analysis, news,
      `Autonomous scanner: ${best.direction.toUpperCase()} candidate on ${best.symbol}, confluence score ${best.score} — ${best.reasons.join("; ")}`,
      `maxRiskPerTrade=${settings.maxRiskPerTradePct}%, minRR=${settings.minRiskReward}`,
    );
    const { decision: ai, logId, valid: aiValid } = await askModel(prompt, best.symbol);
    // If the AI is unreachable it would veto every candidate identically —
    // stop and say so plainly rather than reporting a vague "no setup".
    if (!aiValid) {
      await audit({ actor: `scanner:${trigger}`, userId: user.id, category: "ai", action: "ai_unavailable", detail: { symbol: best.symbol, scanner: true } });
      return {
        scanned: symbolsToScan.length, candidates: summary, directedAnalysis, suggested: null,
        skippedReason: "AI model offline — suggestions paused. Start Ollama and confirm the model is pulled (see Settings / health).",
      };
    }
    if (ai.decision !== best.direction || ai.confidence < 0.65) {
      await audit({ actor: `scanner:${trigger}`, userId: user.id, category: "ai", action: "ai_veto", detail: { symbol: best.symbol, scanner: true, signal: best.direction, ai: ai.decision, confidence: ai.confidence, reasoning: ai.reasoning } });
      continue;
    }

    // 4. Levels + suggested size (user picks the real amount at approval)
    const primary = best.analysis.timeframes.find((t) => t.timeframe === "H1") ?? best.analysis.timeframes[0];
    if (!primary?.atr) continue;
    const entry = best.direction === "buy" ? best.analysis.ask : best.analysis.bid;
    const slDist = primary.atr * 1.5;
    const tpDist = primary.atr * 3.0;
    const stopLoss = ai.suggested_stop_loss ?? (best.direction === "buy" ? entry - slDist : entry + slDist);
    const takeProfit = ai.suggested_take_profit ?? (best.direction === "buy" ? entry + tpDist : entry - tpDist);
    const account = await mt5.accountInfo();
    const suggestedLots = calculateLots(best.symbol, account.balance, settings.maxRiskPerTradePct, entry, stopLoss, settings.maxLotSize);

    // 5. Risk pre-check with the suggested size
    const proposal: TradeProposal = { symbol: best.symbol, direction: best.direction, lots: suggestedLots, entry, stopLoss, takeProfit };
    const ctx = await buildRiskContext(user, settings, account, best.analysis.spreadPoints, primary.atrPct, sessionNow(), news.action);
    const risk = validateTrade(proposal, ctx);
    if (!risk.ok) {
      await audit({ actor: `scanner:${trigger}`, userId: user.id, category: "risk", action: "scanner_suggestion_blocked", detail: { symbol: best.symbol, failed: risk.checks.filter((c) => !c.passed).map((c) => c.name) } });
      continue;
    }

    // 6. Create the suggestion — always approval-gated, never auto-executed
    const trade = await prisma.trade.create({
      data: {
        userId: user.id, accountId: await accountIdForLogin(user.id, account.login, account), symbol: best.symbol,
        direction: best.direction === "buy" ? "BUY" : "SELL",
        lots: suggestedLots, entryPrice: entry, stopLoss, takeProfit,
        status: "PENDING_APPROVAL", mode: "SEMI_AUTO", aiAnalysisId: logId,
        explanation: {
          scanner: true, trigger, confluenceScore: best.score,
          strategy: { name: "Autonomous scanner", reasons: best.reasons },
          ai: { decision: ai.decision, confidence: ai.confidence, reasoning: ai.reasoning, risk_level: ai.risk_level },
          news: { level: news.level, action: news.action, reason: news.reason },
          risk: { ok: true, checks: risk.checks },
        } as object,
        approval: { create: { expiresAt: new Date(Date.now() + 30 * 60_000) } },
      },
    });

    await notify(user.id, "approval_request",
      `AI suggestion: ${best.direction.toUpperCase()} ${best.symbol}`,
      `Confluence ${best.score}/6, AI confidence ${(ai.confidence * 100).toFixed(0)}%.\n` +
      `${ai.reasoning.slice(0, 280)}\n` +
      `Entry ~${entry} | SL ${Number(stopLoss).toFixed(5)} | TP ${Number(takeProfit).toFixed(5)}\n` +
      `Suggested size: ${suggestedLots} lots — YOU choose the amount when approving.\n` +
      `Dashboard: Trades tab · Telegram: /approve_trade ${trade.id} <lots> · Expires in 30 min.`);
    broadcast("approval_request", { tradeId: trade.id, symbol: best.symbol, direction: best.direction, lots: suggestedLots, scanner: true });

    return { scanned: symbolsToScan.length, candidates: summary, directedAnalysis, suggested: { tradeId: trade.id, symbol: best.symbol, direction: best.direction, lots: suggestedLots } };
  }

  return { scanned: symbolsToScan.length, candidates: summary, suggested: null, directedAnalysis, skippedReason: "candidates vetoed by AI/news/risk or already pending" };
}
