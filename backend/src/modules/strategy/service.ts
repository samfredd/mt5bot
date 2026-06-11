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
      reasons: [`Outside allowed sessions (now: ${analysis.session}).`],
      strategyId: strategy.id,
      strategyName: strategy.name,
      config,
    };
  }

  const primary = analysis.timeframes[0];
  const higher = analysis.timeframes[analysis.timeframes.length - 1];
  if (!primary) {
    return { symbol: analysis.symbol, direction: null, reasons: ["No timeframe data."], strategyId: strategy.id, strategyName: strategy.name, config };
  }

  let bullScore = 0;
  let bearScore = 0;

  if (primary.trend === "bullish") { bullScore++; reasons.push(`${primary.timeframe} trend bullish`); }
  if (primary.trend === "bearish") { bearScore++; reasons.push(`${primary.timeframe} trend bearish`); }

  if (config.entry.requireTrendAlignment && higher && higher !== primary) {
    if (higher.trend === "bullish") { bullScore++; reasons.push(`${higher.timeframe} confirms bullish`); }
    else if (higher.trend === "bearish") { bearScore++; reasons.push(`${higher.timeframe} confirms bearish`); }
    else reasons.push(`${higher.timeframe} not aligned (ranging)`);
  }

  if (primary.rsi !== null) {
    if (primary.rsi <= config.entry.rsiOversold) { bullScore++; reasons.push(`RSI oversold (${primary.rsi.toFixed(1)})`); }
    if (primary.rsi >= config.entry.rsiOverbought) { bearScore++; reasons.push(`RSI overbought (${primary.rsi.toFixed(1)})`); }
  }

  if (config.entry.useMacdCross && primary.macdHistogram !== null) {
    if (primary.macdHistogram > 0) { bullScore++; reasons.push("MACD histogram positive"); }
    else if (primary.macdHistogram < 0) { bearScore++; reasons.push("MACD histogram negative"); }
  }

  if (config.entry.useCandlePatterns && primary.candlePattern) {
    if (["hammer", "bullish_engulfing"].includes(primary.candlePattern)) { bullScore++; reasons.push(`Pattern: ${primary.candlePattern}`); }
    if (["shooting_star", "bearish_engulfing"].includes(primary.candlePattern)) { bearScore++; reasons.push(`Pattern: ${primary.candlePattern}`); }
  }

  if (primary.structure === "higher_highs") { bullScore++; reasons.push("Structure: higher highs/lows"); }
  if (primary.structure === "lower_lows") { bearScore++; reasons.push("Structure: lower highs/lows"); }

  let direction: "buy" | "sell" | null = null;
  const threshold = config.entry.requireTrendAlignment ? 3 : 2;
  if (bullScore >= threshold && bullScore > bearScore) direction = "buy";
  else if (bearScore >= threshold && bearScore > bullScore) direction = "sell";
  reasons.push(`Score — bull: ${bullScore}, bear: ${bearScore}, threshold: ${threshold}`);

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

  return { symbol: analysis.symbol, direction, reasons, strategyId: strategy.id, strategyName: strategy.name, config };
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
