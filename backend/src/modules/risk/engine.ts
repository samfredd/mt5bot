import type { RiskSettings } from "@prisma/client";
import {
  fallbackTradingSpec,
  moneyForPriceMove,
  valuePerPointPerLot,
  type TradingInstrumentSpec,
} from "./instruments.js";

/**
 * The risk engine is the FINAL authority on every trade — manual, AI,
 * automatic, or copied. It is deliberately pure (no I/O) so it can be
 * unit-tested exhaustively. A trade proceeds only if every check passes.
 */

export interface TradeProposal {
  symbol: string;
  direction: "buy" | "sell";
  lots: number;
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  isCopyTrade?: boolean;
  instrumentSpec?: TradingInstrumentSpec;
}

export interface RiskContext {
  settings: RiskSettings;
  account: { balance: number; equity: number; margin_level: number };
  openPositions: { symbol: string; volume: number; profit: number }[];
  tradesToday: number;
  copiedTradesToday: number;
  consecutiveLosses: number;
  dailyPnl: number;
  weeklyPnl: number;
  peakEquity: number;
  spreadPoints: number;
  atrPct: number | null;
  session: string;
  newsAction: "allow" | "reduce" | "pause";
  emergencyStop: boolean;
  botRunning: boolean;
  isLiveAccount: boolean;
  liveTradingEnabled: boolean;
  userLiveEnabled: boolean;
  twoFactorVerified: boolean;
  exposureGate?: { passed: boolean; reasons: string[] };
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RiskResult {
  ok: boolean;
  checks: RiskCheck[];
  adjustedLots?: number;
}

export function validateTrade(p: TradeProposal, ctx: RiskContext): RiskResult {
  const checks: RiskCheck[] = [];
  const s = ctx.settings;
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  // --- Hard platform gates ---
  add("emergency_stop", !ctx.emergencyStop, ctx.emergencyStop ? "EMERGENCY STOP is active — all trading halted" : "inactive");
  add("bot_running", ctx.botRunning, ctx.botRunning ? "bot is running" : "bot is not running");

  if (ctx.isLiveAccount) {
    add("live_settings_enabled", ctx.liveTradingEnabled, ctx.liveTradingEnabled ? "live trading enabled in Settings" : "live trading is disabled in Settings");
    add("live_user_enabled", ctx.userLiveEnabled, ctx.userLiveEnabled ? "user enabled live mode" : "user has not enabled live mode");
    add("live_2fa", ctx.twoFactorVerified, ctx.twoFactorVerified ? "2FA verified" : "two-factor confirmation required for live trading");
  } else {
    add("demo_account", true, "demo account — live gates skipped");
  }

  // --- News gate ---
  add("news", ctx.newsAction !== "pause", ctx.newsAction === "pause" ? "news filter says pause" : `news action: ${ctx.newsAction}`);
  if (ctx.exposureGate) {
    add("exposure", ctx.exposureGate.passed, ctx.exposureGate.passed ? "projected exposure within limits" : ctx.exposureGate.reasons.join("; "));
  }

  // --- Stop-loss / take-profit requirements ---
  const hasSl = p.stopLoss !== null && p.stopLoss > 0;
  add("stop_loss_required", !s.requireStopLoss || hasSl, hasSl ? `SL=${p.stopLoss}` : "stop-loss is required for every trade");
  add(
    "take_profit_required",
    !s.requireTakeProfit || (p.takeProfit !== null && p.takeProfit > 0),
    p.takeProfit ? `TP=${p.takeProfit}` : s.requireTakeProfit ? "take-profit required by settings" : "TP optional",
  );

  // --- Risk:reward ---
  if (hasSl && p.takeProfit) {
    const riskDist = Math.abs(p.entry - (p.stopLoss as number));
    const rewardDist = Math.abs((p.takeProfit as number) - p.entry);
    const rr = riskDist > 0 ? rewardDist / riskDist : 0;
    add("min_risk_reward", rr >= s.minRiskReward, `R:R ${rr.toFixed(2)} (min ${s.minRiskReward})`);
  }

  // --- SL direction sanity ---
  if (hasSl) {
    const slValid = p.direction === "buy" ? (p.stopLoss as number) < p.entry : (p.stopLoss as number) > p.entry;
    add("stop_loss_direction", slValid, slValid ? "SL on correct side of entry" : "SL on wrong side of entry");
  }

  // --- Per-trade monetary risk ---
  if (hasSl && ctx.account.balance > 0) {
    // Money at risk = stop distance × per-lot value-per-point, so this is
    // correct across FX majors, JPY pairs, metals, indices and crypto.
    const stopDist = Math.abs(p.entry - (p.stopLoss as number));
    const approxRisk = p.instrumentSpec
      ? Math.abs(moneyForPriceMove(stopDist, p.lots, p.instrumentSpec))
      : stopDist * p.lots * valuePerPointPerLot(p.symbol, p.entry);
    const riskPct = (approxRisk / ctx.account.balance) * 100;
    add("max_risk_per_trade", riskPct <= s.maxRiskPerTradePct * 1.5, `~${riskPct.toFixed(2)}% of balance (max ${s.maxRiskPerTradePct}%)`);
  }

  // --- Lot size ---
  add("max_lot_size", p.lots > 0 && p.lots <= s.maxLotSize, `lots=${p.lots} (max ${s.maxLotSize})`);

  // --- Exposure counts ---
  add("max_open_trades", ctx.openPositions.length < s.maxOpenTrades, `${ctx.openPositions.length}/${s.maxOpenTrades} open`);
  const symbolCount = ctx.openPositions.filter((o) => o.symbol === p.symbol).length;
  add("max_trades_per_symbol", symbolCount < s.maxTradesPerSymbol, `${symbolCount}/${s.maxTradesPerSymbol} on ${p.symbol}`);
  add("max_trades_per_day", ctx.tradesToday < s.maxTradesPerDay, `${ctx.tradesToday}/${s.maxTradesPerDay} today`);
  // Professional circuit breaker: a string of losses means the read on the
  // market is wrong today — stop trading, don't revenge-trade.
  add(
    "max_consecutive_losses",
    ctx.consecutiveLosses < s.maxConsecutiveLosses,
    `${ctx.consecutiveLosses} consecutive losses today (stop at ${s.maxConsecutiveLosses})`,
  );

  // --- Copy-trading limits ---
  if (p.isCopyTrade) {
    add("max_daily_copied_trades", ctx.copiedTradesToday < s.maxDailyCopiedTrades, `${ctx.copiedTradesToday}/${s.maxDailyCopiedTrades} copied today`);
    const copyExposure = ctx.openPositions.reduce((a, o) => a + o.volume, 0) + p.lots;
    const limit = (s.copyExposureLimitPct / 100) * Math.max(ctx.account.balance / 1000, 0.01);
    add("copy_exposure_limit", copyExposure <= limit, `copy exposure ${copyExposure.toFixed(2)} lots (limit ~${limit.toFixed(2)})`);
  }

  // --- Loss limits ---
  if (ctx.account.balance > 0) {
    const dailyLossPct = (-Math.min(ctx.dailyPnl, 0) / ctx.account.balance) * 100;
    add("max_daily_loss", dailyLossPct < s.maxDailyLossPct, `daily loss ${dailyLossPct.toFixed(2)}% (max ${s.maxDailyLossPct}%)`);
    const weeklyLossPct = (-Math.min(ctx.weeklyPnl, 0) / ctx.account.balance) * 100;
    add("max_weekly_loss", weeklyLossPct < s.maxWeeklyLossPct, `weekly loss ${weeklyLossPct.toFixed(2)}% (max ${s.maxWeeklyLossPct}%)`);
  }

  // --- Drawdown & equity protection ---
  if (ctx.peakEquity > 0) {
    const ddPct = ((ctx.peakEquity - ctx.account.equity) / ctx.peakEquity) * 100;
    add("max_drawdown", ddPct < s.maxDrawdownPct, `drawdown ${ddPct.toFixed(2)}% from peak (max ${s.maxDrawdownPct}%)`);
  }
  if (ctx.account.balance > 0) {
    const equityPct = (ctx.account.equity / ctx.account.balance) * 100;
    add("equity_protection", equityPct >= s.equityProtectionPct, `equity at ${equityPct.toFixed(1)}% of balance (floor ${s.equityProtectionPct}%)`);
  }

  // --- Market conditions ---
  add("max_spread", ctx.spreadPoints <= s.maxSpreadPoints, `spread ${ctx.spreadPoints} pts (max ${s.maxSpreadPoints})`);
  if (ctx.atrPct !== null) {
    add("volatility_limit", ctx.atrPct <= s.maxAtrVolatilityPct, `ATR ${ctx.atrPct.toFixed(2)}% (max ${s.maxAtrVolatilityPct}%)`);
  }

  // --- Session ---
  const sessions = (Array.isArray(s.allowedSessions) ? s.allowedSessions : []) as string[];
  add("trading_session", sessions.length === 0 || sessions.includes(ctx.session), `session ${ctx.session} (allowed: ${sessions.join(", ") || "any"})`);

  const ok = checks.every((c) => c.passed);
  // When news says "reduce", halve the lot size rather than block.
  const adjustedLots = ctx.newsAction === "reduce" ? Math.max(0.01, Math.round(p.lots * 50) / 100) : p.lots;
  return { ok, checks, adjustedLots };
}

/**
 * Most-recent run of losing trades, for the circuit breaker. `trades` must be
 * ordered most-recent-first. A trade whose profit is not yet reconciled
 * (`null`) is SKIPPED — never treated as a win — so an attribution gap can't
 * silently reset the breaker and let revenge-trading through.
 */
export function countConsecutiveLosses(trades: { profit: number | null }[]): number {
  let streak = 0;
  for (const t of trades) {
    if (t.profit === null) continue; // unknown outcome — don't count, don't reset
    if (t.profit < 0) streak++;
    else break;
  }
  return streak;
}

/**
 * Capital-protection guardian: returns the reasons (if any) to FLATTEN all
 * open positions, not just block new ones. Pure so it can be tested.
 *
 * Triggers on the equity-protection floor only — equity below a fraction of
 * balance is realized+floating loss against deposited capital. Drawdown from
 * peak is deliberately NOT used here (peak includes floating gains, so it
 * would flatten winners on ordinary pullbacks); that stays a new-trade gate.
 */
export function equityGuardianBreaches(
  account: { balance: number; equity: number },
  settings: Pick<RiskSettings, "equityProtectionPct">,
): string[] {
  const breaches: string[] = [];
  if (account.balance > 0) {
    const equityPct = (account.equity / account.balance) * 100;
    if (equityPct < settings.equityProtectionPct) {
      breaches.push(`equity at ${equityPct.toFixed(1)}% of balance (protection floor ${settings.equityProtectionPct}%)`);
    }
  }
  return breaches;
}

/**
 * Position sizing from risk percentage and stop distance. `symbol` is
 * required so the per-lot value is correct for the instrument (gold, JPY
 * pairs, indices and crypto are NOT $10/pip on a 100k contract).
 */
export function calculateLots(
  symbol: string,
  balance: number,
  riskPct: number,
  entry: number,
  stopLoss: number,
  maxLot: number,
  instrumentSpec?: TradingInstrumentSpec,
): number {
  const riskAmount = balance * (riskPct / 100);
  const stopDist = Math.abs(entry - stopLoss);
  const spec = instrumentSpec ?? fallbackTradingSpec(symbol, entry);
  const minLot = Math.max(spec.volumeMin, 0.00000001);
  const maxAllowed = Math.max(minLot, Math.min(maxLot, spec.volumeMax));
  const step = Math.max(spec.volumeStep, 0.00000001);
  if (stopDist <= 0 || riskAmount <= 0) return minLot;
  const perLotRisk = Math.abs(moneyForPriceMove(stopDist, 1, spec));
  if (perLotRisk <= 0) return minLot;

  const rawLots = riskAmount / perLotRisk;
  if (rawLots <= minLot) return minLot;
  const floored = Math.floor((rawLots + step * 1e-9) / step) * step;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(Math.min(Math.max(floored, minLot), maxAllowed).toFixed(decimals));
}
