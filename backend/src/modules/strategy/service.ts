import type { Strategy } from "@prisma/client";
import type { MarketAnalysis } from "../analysis/engine.js";
import { StrategyConfigSchema, type StrategySignal } from "./types.js";

/**
 * Rule-based signal generation. The strategy engine proposes; the AI then
 * reasons over the proposal, and the risk engine has the final word.
 */
export function evaluateStrategy(strategy: Strategy, analysis: MarketAnalysis): StrategySignal {
  const parsed = StrategyConfigSchema.safeParse(strategy.config);
  if (!parsed.success) {
    return {
      symbol: analysis.symbol,
      direction: null,
      confidence: 0,
      reasons: ["Strategy config invalid — no signal."],
      strategyId: strategy.id,
      strategyName: strategy.name,
      config: StrategyConfigSchema.parse({ symbols: [analysis.symbol], entry: {}, exit: {}, lotSizing: {} }),
    };
  }
  const config = parsed.data;
  const reasons: string[] = [];

  if (!config.sessions.includes(analysis.session)) {
    return {
      symbol: analysis.symbol,
      direction: null,
      confidence: 0,
      reasons: [`Outside allowed sessions (now: ${analysis.session}).`],
      strategyId: strategy.id,
      strategyName: strategy.name,
      config,
    };
  }

  const primary = analysis.timeframes[0];
  const higher = analysis.timeframes[analysis.timeframes.length - 1];
  if (!primary) {
    return { symbol: analysis.symbol, direction: null, confidence: 0, reasons: ["No timeframe data."], strategyId: strategy.id, strategyName: strategy.name, config };
  }

  if (config.entry.style === "mean_reversion") {
    return evaluateMeanReversion(strategy, config, analysis, primary, higher, reasons);
  }
  if (config.entry.style === "breakout") {
    return evaluateBreakout(strategy, config, analysis, primary, reasons);
  }

  let bullScore = 0;
  let bearScore = 0;
  const usePrimaryTrend = config.entry.usePrimaryTrend !== false;
  const useRsi = config.entry.useRsi !== false;
  const useStructure = config.entry.useStructure !== false;
  const possibleScore = Number(usePrimaryTrend) + Number(useRsi) + Number(config.entry.useMacdCross) +
    Number(config.entry.useCandlePatterns) + Number(useStructure);

  if (usePrimaryTrend && primary.trend === "bullish") { bullScore++; reasons.push(`${primary.timeframe} trend bullish`); }
  if (usePrimaryTrend && primary.trend === "bearish") { bearScore++; reasons.push(`${primary.timeframe} trend bearish`); }

  if (useRsi && primary.rsi !== null && primary.rsiPrevious !== null) {
    if (primary.rsiPrevious <= config.entry.rsiOversold && primary.rsi > config.entry.rsiOversold) {
      bullScore++;
      reasons.push(`RSI recovered above ${config.entry.rsiOversold} (${primary.rsiPrevious.toFixed(1)} → ${primary.rsi.toFixed(1)})`);
    }
    if (primary.rsiPrevious >= config.entry.rsiOverbought && primary.rsi < config.entry.rsiOverbought) {
      bearScore++;
      reasons.push(`RSI fell below ${config.entry.rsiOverbought} (${primary.rsiPrevious.toFixed(1)} → ${primary.rsi.toFixed(1)})`);
    }
  }

  if (config.entry.useMacdCross &&
      primary.macdPrevious !== null && primary.macdCurrent !== null &&
      primary.signalPrevious !== null && primary.signalCurrent !== null) {
    if (primary.macdPrevious <= primary.signalPrevious && primary.macdCurrent > primary.signalCurrent) {
      bullScore++;
      reasons.push("MACD crossed above signal");
    }
    if (primary.macdPrevious >= primary.signalPrevious && primary.macdCurrent < primary.signalCurrent) {
      bearScore++;
      reasons.push("MACD crossed below signal");
    }
  }

  if (config.entry.useCandlePatterns && primary.candlePattern) {
    if (["hammer", "bullish_engulfing"].includes(primary.candlePattern)) { bullScore++; reasons.push(`Pattern: ${primary.candlePattern}`); }
    if (["shooting_star", "bearish_engulfing"].includes(primary.candlePattern)) { bearScore++; reasons.push(`Pattern: ${primary.candlePattern}`); }
  }

  if (useStructure && primary.structure === "higher_highs") { bullScore++; reasons.push("Structure: higher highs/lows"); }
  if (useStructure && primary.structure === "lower_lows") { bearScore++; reasons.push("Structure: lower highs/lows"); }

  let direction: "buy" | "sell" | null = null;
  const threshold = Math.min(2, Math.max(1, possibleScore));
  if (bullScore >= threshold && bullScore > bearScore) direction = "buy";
  else if (bearScore >= threshold && bearScore > bullScore) direction = "sell";
  reasons.push(`Score — bull: ${bullScore}, bear: ${bearScore}, threshold: ${threshold}`);

  if (direction && config.entry.requireTrendAlignment && higher && higher !== primary) {
    const aligned = direction === "buy" ? higher.trend === "bullish" : higher.trend === "bearish";
    if (aligned) reasons.push(`${higher.timeframe} confirms ${direction === "buy" ? "bullish" : "bearish"}`);
    else {
      reasons.push(`Rejected: ${higher.timeframe} trend ${higher.trend} conflicts with ${direction.toUpperCase()}`);
      direction = null;
    }
  }

  // Anti-chasing filter: professionals enter on pullbacks, not after the
  // move has already run. If price is stretched more than 1.5 ATR from its
  // 20 EMA in the trade direction, stand aside and wait for the retest.
  if (direction && primary.emaFast !== null && primary.atr && primary.lastClose !== null) {
    const extension = (primary.lastClose - primary.emaFast) / primary.atr;
    if ((direction === "buy" && extension > 1.5) || (direction === "sell" && extension < -1.5)) {
      reasons.push(`Rejected: over-extended ${Math.abs(extension).toFixed(1)} ATR from EMA20 — waiting for pullback, not chasing`);
      direction = null;
    }
  }

  const directionalScore = direction === "buy" ? bullScore : direction === "sell" ? bearScore : Math.max(bullScore, bearScore);
  const confidence = possibleScore > 0 ? Number((directionalScore / possibleScore).toFixed(4)) : 0;
  return { symbol: analysis.symbol, direction, confidence, reasons, strategyId: strategy.id, strategyName: strategy.name, config };
}

/**
 * Mean-reversion: fade stretched moves back toward the mean — the opposite of
 * the trend engine. Discipline that keeps it from being "catch a falling knife":
 *   1. Trigger on a Bollinger-band extreme confirmed by an RSI extreme.
 *   2. Filter by the HIGHER timeframe: only fade WITH its bias (buy dips in an
 *      up/ranging market, sell rips in a down/ranging one) — never against it.
 *      (Gating on the PRIMARY trend is self-defeating: a sharp band break
 *      usually flips the primary trend away from "ranging" at that very bar.)
 *   3. Optional reversal-candle confirmation.
 */
function evaluateMeanReversion(
  strategy: Strategy,
  config: ReturnType<typeof StrategyConfigSchema.parse>,
  analysis: MarketAnalysis,
  primary: MarketAnalysis["timeframes"][number],
  higher: MarketAnalysis["timeframes"][number] | undefined,
  reasons: string[],
): StrategySignal {
  const done = (direction: "buy" | "sell" | null) =>
    ({ symbol: analysis.symbol, direction, confidence: direction ? 1 : 0, reasons, strategyId: strategy.id, strategyName: strategy.name, config });

  // Regime filter: a strong trend (high ADX) is exactly where fading gets run
  // over. Judge it on the higher timeframe (steadier than the entry TF).
  const maxAdx = config.entry.regimeMaxAdx;
  if (maxAdx && maxAdx > 0) {
    const regimeTf = higher && higher !== primary ? higher : primary;
    if (regimeTf.adx !== null && regimeTf.adx > maxAdx) {
      reasons.push(`regime too trendy — ${regimeTf.timeframe} ADX ${regimeTf.adx.toFixed(0)} > ${maxAdx}; mean-reversion stands aside`);
      return done(null);
    }
  }

  const rsiV = primary.rsi;
  const bb = primary.bollingerPosition;
  const confirm = config.entry.useCandlePatterns;
  const higherTrend = higher && higher !== primary ? higher.trend : "ranging";

  // Long: stretched below the lower band + oversold RSI.
  if (bb === "below_lower" && rsiV !== null && rsiV <= config.entry.rsiOversold) {
    if (higherTrend === "bearish") { reasons.push(`oversold, but ${higher?.timeframe} is bearish — won't fade a downtrend`); return done(null); }
    const ok = !confirm || ["hammer", "bullish_engulfing", "doji"].includes(primary.candlePattern ?? "");
    if (!ok) { reasons.push(`oversold below band but no reversal candle yet (${primary.candlePattern ?? "none"})`); return done(null); }
    reasons.push(`price below lower Bollinger band + RSI ${rsiV.toFixed(1)} ≤ ${config.entry.rsiOversold}${confirm ? ` + ${primary.candlePattern}` : ""} — fading the dip toward the mean`);
    return done("buy");
  }

  // Short: stretched above the upper band + overbought RSI.
  if (bb === "above_upper" && rsiV !== null && rsiV >= config.entry.rsiOverbought) {
    if (higherTrend === "bullish") { reasons.push(`overbought, but ${higher?.timeframe} is bullish — won't fade an uptrend`); return done(null); }
    const ok = !confirm || ["shooting_star", "bearish_engulfing", "doji"].includes(primary.candlePattern ?? "");
    if (!ok) { reasons.push(`overbought above band but no reversal candle yet (${primary.candlePattern ?? "none"})`); return done(null); }
    reasons.push(`price above upper Bollinger band + RSI ${rsiV.toFixed(1)} ≥ ${config.entry.rsiOverbought}${confirm ? ` + ${primary.candlePattern}` : ""} — fading the spike toward the mean`);
    return done("sell");
  }

  reasons.push(`no band extreme to fade (BB ${bb ?? "n/a"}, RSI ${rsiV?.toFixed(1) ?? "n/a"})`);
  return done(null);
}

/**
 * Session breakout: trade the first London-session break of the overnight
 * Asian range (the session gate at the top of evaluateStrategy already limits
 * this to the configured London sessions). A genuinely different mechanic —
 * time-and-level based, not indicator confluence.
 */
function evaluateBreakout(
  strategy: Strategy,
  config: ReturnType<typeof StrategyConfigSchema.parse>,
  analysis: MarketAnalysis,
  primary: MarketAnalysis["timeframes"][number],
  reasons: string[],
): StrategySignal {
  const done = (direction: "buy" | "sell" | null) =>
    ({ symbol: analysis.symbol, direction, confidence: direction ? 1 : 0, reasons, strategyId: strategy.id, strategyName: strategy.name, config });

  const range = analysis.referenceRange;
  const close = primary.lastClose;
  if (!range) { reasons.push("no completed Asian-session range yet — nothing to break"); return done(null); }
  if (close === null) { reasons.push("no price"); return done(null); }

  reasons.push(`Asian range ${range.low} – ${range.high}`);
  if (close > range.high) {
    reasons.push(`close ${close} broke ABOVE the range — long breakout`);
    return done("buy");
  }
  if (close < range.low) {
    reasons.push(`close ${close} broke BELOW the range — short breakout`);
    return done("sell");
  }
  reasons.push(`price still inside the range — no breakout`);
  return done(null);
}

/** SL/TP derived from ATR per the strategy's exit rules. */
export function deriveLevels(
  signal: StrategySignal,
  analysis: MarketAnalysis,
): { entry: number; stopLoss: number; takeProfit: number } | null {
  const primary = analysis.timeframes[0];
  if (!signal.direction || !primary?.atr || !primary.lastClose) return null;
  const entry = signal.direction === "buy" ? analysis.ask : analysis.bid;
  const slDist = primary.atr * signal.config.exit.stopLossAtrMult;
  const tpDist = primary.atr * signal.config.exit.takeProfitAtrMult;
  return signal.direction === "buy"
    ? { entry, stopLoss: entry - slDist, takeProfit: entry + tpDist }
    : { entry, stopLoss: entry + slDist, takeProfit: entry - tpDist };
}
