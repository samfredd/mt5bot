import { marketKey } from "../trading/symbol-lock.js";
import { countConsecutiveLosses } from "../risk/engine.js";
import type { ScalpingConfig, ScalpingRiskConfig } from "./scalping.schema.js";
import { aiFireControlActive } from "./scalping.types.js";
import type { ActiveScalp, ClosedScalp, ScalpingAiDecision } from "./scalping.types.js";
import { exposureCapPct } from "./scalping.presets.js";

/**
 * The scalping risk layer — PURE, no I/O, so every rule is unit-testable.
 *
 * This is the FIRST gate (scalping-specific behavior). It does NOT replace the
 * global risk engine: the worker runs these checks, then still calls the global
 * `validateTrade()` as the final authority before any broker order. Order:
 *
 *   Scalping Worker → THIS layer → global validateTrade() → MT5 bridge
 */

export interface ScalpGateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ScalpGateResult {
  ok: boolean;
  reason: string;
  checks: ScalpGateCheck[];
}

/** Base+quote currencies for an FX/metal symbol (best-effort from the 6-char core). */
export function currencies(symbol: string): string[] {
  const core = marketKey(symbol);
  if (core.length < 6) return [core];
  return [core.slice(0, 3), core.slice(3, 6)];
}

/** One active scalping trade per pair — the headline rule of Multi-Pair mode. */
export function hasActiveScalpForSymbol(active: ActiveScalp[], symbol: string): boolean {
  const key = marketKey(symbol);
  return active.some((a) => marketKey(a.symbol) === key);
}

export function withinMaxTotal(activeCount: number, max: number): boolean {
  return activeCount < max;
}

/**
 * Milliseconds still to wait before re-entering `symbol`. 0 = cooldown elapsed.
 * Win → short delay (`reentryAfterWinSeconds`); loss or unreconciled → long
 * delay (`reentryAfterLossSeconds`, the conservative side).
 */
export function reentryCooldownRemainingMs(
  lastClosed: ClosedScalp | null,
  risk: Pick<ScalpingRiskConfig, "reentryAfterWinSeconds" | "reentryAfterLossSeconds">,
  now = Date.now(),
): number {
  if (!lastClosed) return 0;
  const won = (lastClosed.profit ?? 0) > 0;
  const waitSec = won ? risk.reentryAfterWinSeconds : risk.reentryAfterLossSeconds;
  const elapsed = now - lastClosed.closedAt.getTime();
  return Math.max(0, waitSec * 1000 - elapsed);
}

/**
 * If the consecutive-loss streak has hit the cap, returns the epoch-ms until
 * which new scalping entries are paused (a time-boxed cooldown measured from the
 * most recent loss). Returns null when not paused. Time-boxed on purpose: a
 * permanent halt would deadlock (no trades → no win → never resets).
 */
export function lossStreakPauseUntil(
  recentClosedDesc: ClosedScalp[],
  risk: Pick<ScalpingRiskConfig, "maxConsecutiveLosses" | "pauseAfterLossStreakMinutes">,
  now = Date.now(),
): number | null {
  const streak = countConsecutiveLosses(recentClosedDesc.map((t) => ({ profit: t.profit })));
  if (streak < risk.maxConsecutiveLosses) return null;
  const lastLoss = recentClosedDesc.find((t) => (t.profit ?? 0) < 0);
  if (!lastLoss) return null;
  const until = lastLoss.closedAt.getTime() + risk.pauseAfterLossStreakMinutes * 60_000;
  return until > now ? until : null;
}

/** True when today's realized scalping loss has hit the money or percent cap. */
export function dailyLossExceeded(
  todayNetProfit: number,
  balance: number,
  risk: Pick<ScalpingRiskConfig, "dailyLossLimitMoney" | "dailyLossLimitPercent">,
): boolean {
  const lossMoney = -Math.min(todayNetProfit, 0);
  if (risk.dailyLossLimitMoney != null && lossMoney >= risk.dailyLossLimitMoney) return true;
  if (risk.dailyLossLimitPercent != null && balance > 0 && (lossMoney / balance) * 100 >= risk.dailyLossLimitPercent) {
    return true;
  }
  return false;
}

/**
 * Session profit goal. True once the day's net realized scalp P/L has reached
 * the configured target — at which point the engine flattens and stops.
 */
export function profitTargetReached(todayNetProfit: number, target: number | null | undefined): boolean {
  return target != null && todayNetProfit >= target;
}

/**
 * Total simultaneous open risk ceiling. With risk-percent sizing, every open
 * trade risks ~riskPct of balance, so the worst case if all slots fill is
 * `maxOpen × riskPct`. This must stay within the preset's exposure cap (Low 1%,
 * Medium 2%, Aggressive/Custom 5%) — the hard limit that keeps even Aggressive
 * from being reckless. Only meaningful in risk-percent lot mode.
 */
export function totalExposureExceedsCap(maxOpen: number, riskPct: number, capPct: number): boolean {
  return maxOpen * riskPct > capPct + 1e-9;
}

/**
 * Per-trade exit decision for one open scalp. Basis-aware:
 * - "points": close when price has moved `takeProfitPoints` in favour or
 *   `stopLossPoints` against (needs the signed move in points).
 * - "money" (or points without both values / no point move available): close on
 *   the floating $ target / max loss — the original behavior.
 * Returns the close reason, or null to keep holding.
 */
export function scalpExitReason(
  pos: { profit: number; pointsMoved: number | null },
  risk: Pick<ScalpingRiskConfig, "stopBasis" | "targetProfitMoney" | "maxLossMoney" | "takeProfitPoints" | "stopLossPoints">,
): "SCALP_TP_MONEY" | "SCALP_MAX_LOSS_MONEY" | null {
  if (risk.stopBasis === "points" && risk.takeProfitPoints != null && risk.stopLossPoints != null && pos.pointsMoved != null) {
    if (pos.pointsMoved >= risk.takeProfitPoints) return "SCALP_TP_MONEY";
    if (pos.pointsMoved <= -risk.stopLossPoints) return "SCALP_MAX_LOSS_MONEY";
    return null;
  }
  if (pos.profit >= risk.targetProfitMoney) return "SCALP_TP_MONEY";
  if (pos.profit <= -risk.maxLossMoney) return "SCALP_MAX_LOSS_MONEY";
  return null;
}

/** Would opening `candidate` push any shared currency past the exposure cap? */
export function currencyExposureWouldExceed(activeSymbols: string[], candidate: string, cap: number): boolean {
  const cand = currencies(candidate);
  for (const ccy of cand) {
    const touching = activeSymbols.filter((s) => currencies(s).includes(ccy)).length;
    if (touching + 1 > cap) return true;
  }
  return false;
}

/** Scalping-specific spread cap (per symbol). Unset symbol defers to the global engine. */
export function spreadOk(spreadPoints: number, symbol: string, map: Record<string, number>): boolean {
  const limit = map[symbol.toUpperCase()] ?? map[marketKey(symbol)];
  return limit === undefined ? true : spreadPoints <= limit;
}

/** Collapse the engine's "london_newyork_overlap" to the operator-facing "newyork_overlap". */
export function canonicalSession(session: string): string {
  return session === "london_newyork_overlap" ? "newyork_overlap" : session;
}

export function sessionAllowed(session: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const s = canonicalSession(session);
  const allowedSet = allowed.map(canonicalSession);
  if (allowedSet.includes(s)) return true;
  // The London/NY overlap is a sub-window of BOTH sessions — both desks are
  // open. Allowing "london" or "newyork" therefore implies the overlap (the
  // highest-liquidity scalping window); blocking it while its parent sessions
  // are allowed is never intended. Not symmetric: allowing ONLY the overlap
  // (the Low preset) still excludes the plain london/newyork hours.
  if (s === "newyork_overlap" && (allowedSet.includes("london") || allowedSet.includes("newyork"))) return true;
  return false;
}

/**
 * AI fire control. The AI never originates a trade — direction comes from the
 * technical read; the AI only PERMITS or BLOCKS firing in that direction.
 * - STRICT: AI must agree with `direction` and clear `minAiConfidence`; an
 *   unreachable/invalid model fails closed.
 * - ADVISORY: logged but only blocks on a strong "avoid" or high risk.
 * - PURE_LOGIC: no model call — always permits; technicals + risk gates decide.
 */
export function aiPermitsFire(
  ai: ScalpingAiDecision | null,
  direction: "buy" | "sell",
  config: Pick<ScalpingConfig, "useAiFireControl" | "aiMode" | "minAiConfidence">,
): { ok: boolean; reason: string } {
  if (!aiFireControlActive(config)) {
    return {
      ok: true,
      reason: config.aiMode === "PURE_LOGIC" ? "PURE_LOGIC mode — technicals only, no AI gate" : "AI fire control disabled",
    };
  }

  if (!ai || !ai.valid) {
    return config.aiMode === "STRICT"
      ? { ok: false, reason: "AI unavailable/invalid — STRICT fails closed" }
      : { ok: true, reason: "AI unavailable — ADVISORY allows" };
  }

  if (config.aiMode === "STRICT") {
    if (ai.decision !== direction) return { ok: false, reason: `AI says ${ai.decision}, signal is ${direction}` };
    if (ai.confidence < config.minAiConfidence) {
      return { ok: false, reason: `AI confidence ${ai.confidence.toFixed(2)} < ${config.minAiConfidence}` };
    }
    return { ok: true, reason: `AI agrees ${direction} @ ${ai.confidence.toFixed(2)} (STRICT)` };
  }

  // ADVISORY
  if (ai.decision === "avoid" || ai.riskLevel === "high") {
    return { ok: false, reason: `ADVISORY block: AI ${ai.decision}, risk ${ai.riskLevel}` };
  }
  return { ok: true, reason: `ADVISORY allows (AI ${ai.decision})` };
}

export interface ScalpGateInput {
  config: ScalpingConfig;
  risk: ScalpingRiskConfig;
  symbol: string;
  direction: "buy" | "sell";
  globalEmergencyStop: boolean;
  redisAvailable: boolean;
  active: ActiveScalp[];
  tradesToday: number;
  lastClosedForSymbol: ClosedScalp | null;
  recentClosedDesc: ClosedScalp[];
  todayNetProfit: number;
  balance: number;
  spreadPoints: number;
  session: string;
  newsAction: "allow" | "reduce" | "pause";
  ai: ScalpingAiDecision | null;
  now?: number;
}

/**
 * Compose the full scalping-specific gate for ONE candidate. Returns the first
 * failing reason plus the full check list (for the decision trail / UI). The
 * global `validateTrade()` still runs AFTER this passes.
 */
export function evaluateScalpingGate(input: ScalpGateInput): ScalpGateResult {
  const now = input.now ?? Date.now();
  const r = input.risk;
  const checks: ScalpGateCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  add("scalping_running", input.config.status === "running" && input.config.enabled,
    input.config.status === "running" ? "scalping running" : `scalping ${input.config.status}`);
  add("not_emergency_stopped", !input.globalEmergencyStop, input.globalEmergencyStop ? "global emergency stop active" : "ok");
  add("operational_redis", input.redisAvailable, input.redisAvailable ? "redis available" : "redis unavailable — fail closed");
  add("symbol_in_watchlist", input.config.symbols.map((s) => s.toUpperCase()).includes(input.symbol.toUpperCase()),
    `${input.symbol} ${input.config.symbols.map((s) => s.toUpperCase()).includes(input.symbol.toUpperCase()) ? "in" : "not in"} watchlist`);

  add("max_open_total", withinMaxTotal(input.active.length, r.maxOpenTradesTotal), `${input.active.length}/${r.maxOpenTradesTotal} open`);
  add("one_per_symbol", !hasActiveScalpForSymbol(input.active, input.symbol), `active on ${marketKey(input.symbol)}? ${hasActiveScalpForSymbol(input.active, input.symbol)}`);
  add("max_trades_per_day", input.tradesToday < r.maxTradesPerDay, `${input.tradesToday}/${r.maxTradesPerDay} today`);

  const cooldownMs = reentryCooldownRemainingMs(input.lastClosedForSymbol, r, now);
  add("reentry_cooldown", cooldownMs <= 0, cooldownMs > 0 ? `${Math.ceil(cooldownMs / 1000)}s remaining` : "ready");

  const pauseUntil = lossStreakPauseUntil(input.recentClosedDesc, r, now);
  add("loss_streak_pause", pauseUntil === null, pauseUntil ? `paused until ${new Date(pauseUntil).toISOString()}` : "ok");

  add("daily_loss_limit", !dailyLossExceeded(input.todayNetProfit, input.balance, r), `net today ${input.todayNetProfit.toFixed(2)}`);
  add("profit_target", !profitTargetReached(input.todayNetProfit, r.profitTargetMoney),
    r.profitTargetMoney != null ? `net today ${input.todayNetProfit.toFixed(2)} / goal ${r.profitTargetMoney}` : "no goal set");

  if (r.lotMode === "risk_percent") {
    const cap = exposureCapPct(r.scalpingRiskPreset);
    add("exposure_cap", !totalExposureExceedsCap(r.maxOpenTradesTotal, r.riskPerTradePercent, cap),
      `${(r.maxOpenTradesTotal * r.riskPerTradePercent).toFixed(2)}% of ${r.maxOpenTradesTotal} slots / cap ${cap}% (${r.scalpingRiskPreset})`);
  }

  add("currency_exposure", !currencyExposureWouldExceed(input.active.map((a) => a.symbol), input.symbol, r.maxSharedCurrencyExposure),
    `cap ${r.maxSharedCurrencyExposure} per currency`);

  add("scalp_spread", spreadOk(input.spreadPoints, input.symbol, r.maxSpreadPointsBySymbol), `spread ${input.spreadPoints} pts`);
  add("session", sessionAllowed(input.session, r.allowedSessions), `session ${canonicalSession(input.session)} (allowed: ${r.allowedSessions.join(", ") || "any"})`);
  add("news", !(r.pauseDuringNews && input.newsAction === "pause"), input.newsAction === "pause" ? "news says pause" : `news ${input.newsAction}`);

  const aiGate = aiPermitsFire(input.ai, input.direction, input.config);
  add("ai_fire_control", aiGate.ok, aiGate.reason);

  const firstFail = checks.find((c) => !c.passed);
  return { ok: !firstFail, reason: firstFail ? `${firstFail.name}: ${firstFail.detail}` : "all scalping gates passed", checks };
}
