import { writeFile } from "node:fs/promises";
import { mt5, type Candle } from "../src/modules/mt5/client.js";
import { runBacktest, runWalkForward, type BacktestConfig } from "../src/modules/backtest/engine.js";
import type { BacktestTrade } from "../src/modules/backtest/types.js";
import { fallbackTradingSpec, moneyForPriceMove } from "../src/modules/risk/instruments.js";

const symbol = process.argv[3] ?? "EURUSD";
const outputPath = process.argv[2];
const days = 365;
const currentStrategy = {
  id: "forensic-audit",
  name: "Current supplied strategy",
  config: {
    symbols: ["EURUSD", "GBPUSD"],
    sessions: ["london", "london_newyork_overlap"],
    timeframes: ["H1", "H4"],
    newsBehavior: "pause",
    maxTradesPerDay: 3,
    lotSizing: { method: "risk_pct", riskPct: 0.5, fixedLots: 0.01 },
    entry: {
      style: "confluence",
      rsiOversold: 40,
      rsiOverbought: 60,
      useMacdCross: true,
      minConfidence: 0.78,
      useCandlePatterns: true,
      requireTrendAlignment: true,
    },
    exit: { trailingStop: true, stopLossAtrMult: 1.5, takeProfitAtrMult: 2.4 },
  },
};

const summary = (result: ReturnType<typeof runBacktest>) => ({
  trades: result.stats.trades,
  winRate: result.stats.winRate,
  profitFactor: result.stats.profitFactor,
  expectancy: result.stats.expectancy,
  averageWin: result.stats.avgWin,
  averageLoss: result.stats.avgLoss,
  netReturn: result.stats.returnPct,
  maxDrawdown: result.stats.maxDrawdownPct,
  finalBalance: result.stats.finalBalance,
  grossProfit: result.stats.grossProfit,
  grossLoss: result.stats.grossLoss,
  sameBarAmbiguous: result.stats.sameBarAmbiguousExitCount,
  spreadCost: result.stats.totalSpreadCost,
  commission: result.stats.totalCommission,
  slippage: result.stats.totalSlippage,
});

function independentEma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const out = [values.slice(0, period).reduce((sum, value) => sum + value, 0) / period];
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out.push(alpha * values[i] + (1 - alpha) * out.at(-1)!);
  return out;
}

function independentRsi(values: number[], period = 14): number[] {
  if (values.length <= period) return [];
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const out = [avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)];
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function independentMacd(values: number[]) {
  const fast = independentEma(values, 12);
  const slow = independentEma(values, 26);
  const offset = fast.length - slow.length;
  const line = slow.map((value, index) => fast[index + offset] - value);
  const signal = independentEma(line, 9);
  return { line, signal };
}

function independentAtr(candles: Candle[], period = 14): number | null {
  if (candles.length <= period) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  return trueRanges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function chooseAcross(trades: BacktestTrade[], count: number): BacktestTrade[] {
  if (trades.length <= count) return trades;
  return Array.from({ length: count }, (_, index) => trades[Math.floor(index * (trades.length - 1) / (count - 1))]);
}

function independentLotSize(trade: BacktestTrade, instrument: Awaited<ReturnType<typeof mt5.symbolInfo>>): number {
  const riskAmount = trade.balanceBefore * 0.005;
  const stopDistance = Math.abs(trade.entryPrice - trade.stopLoss);
  const perLotRisk = Math.abs(moneyForPriceMove(stopDistance, 1, instrument));
  const raw = perLotRisk > 0 ? riskAmount / perLotRisk : instrument.volumeMin;
  const maximum = Math.min(1, instrument.volumeMax);
  if (raw <= instrument.volumeMin) return instrument.volumeMin;
  const floored = Math.floor((raw + instrument.volumeStep * 1e-9) / instrument.volumeStep) * instrument.volumeStep;
  const decimals = Math.max(0, Math.ceil(-Math.log10(instrument.volumeStep)));
  return Number(Math.min(floored, maximum).toFixed(decimals));
}

const tick = await mt5.tick(symbol);
const primaryCount = Math.ceil((days * 1440 * (5 / 7)) / 60) + 250;
const h4Count = Math.ceil((days * 1440 * (5 / 7)) / 240) + 250;
const [h1, h4] = await Promise.all([
  mt5.candles(symbol, "H1", primaryCount),
  mt5.candles(symbol, "H4", h4Count),
]);
const instrument = await mt5.symbolInfo(symbol).catch(() => fallbackTradingSpec(symbol, tick.bid));
const baseConfig: BacktestConfig = {
  initialBalance: 10_000,
  spreadPoints: 15,
  slippagePoints: 2,
  commissionPerLot: 7,
  maxLotSize: 1,
  sameBarPolicy: "stop_first",
  instrument,
};
const options = {
  timeframeCandles: { H1: h1, H4: h4 },
  asOfMs: Date.parse(tick.time),
};

const stagedCosts = {
  zeroCosts: runBacktest(currentStrategy as never, symbol, h1, { ...baseConfig, spreadPoints: 0, slippagePoints: 0, commissionPerLot: 0 }, options),
  spreadOnly: runBacktest(currentStrategy as never, symbol, h1, { ...baseConfig, slippagePoints: 0, commissionPerLot: 0 }, options),
  spreadAndCommission: runBacktest(currentStrategy as never, symbol, h1, { ...baseConfig, slippagePoints: 0 }, options),
  allCosts: runBacktest(currentStrategy as never, symbol, h1, baseConfig, options),
};
const trailingDisabledStrategy = {
  ...currentStrategy,
  config: { ...currentStrategy.config, exit: { ...currentStrategy.config.exit, trailingStop: false } },
};
const trailingDisabled = runBacktest(trailingDisabledStrategy as never, symbol, h1, baseConfig, options);
const tpFirst = runBacktest(currentStrategy as never, symbol, h1, { ...baseConfig, sameBarPolicy: "tp_first" }, options);
const walkForward = runWalkForward(currentStrategy as never, symbol, h1, baseConfig, 4, options);

const featureConfig = (flags: Record<string, boolean>, trailingStop = true) => ({
  ...currentStrategy,
  config: {
    ...currentStrategy.config,
    entry: { ...currentStrategy.config.entry, ...flags },
    exit: { ...currentStrategy.config.exit, trailingStop },
  },
});
const ablations = [
  ["trend_alignment_only", featureConfig({ usePrimaryTrend: true, useRsi: false, useMacdCross: false, useCandlePatterns: false, useStructure: false })],
  ["trend_plus_rsi", featureConfig({ usePrimaryTrend: true, useRsi: true, useMacdCross: false, useCandlePatterns: false, useStructure: false })],
  ["trend_plus_macd", featureConfig({ usePrimaryTrend: true, useRsi: false, useMacdCross: true, useCandlePatterns: false, useStructure: false })],
  ["trend_plus_candle_patterns", featureConfig({ usePrimaryTrend: true, useRsi: false, useMacdCross: false, useCandlePatterns: true, useStructure: false })],
  ["trend_plus_rsi_plus_macd", featureConfig({ usePrimaryTrend: true, useRsi: true, useMacdCross: true, useCandlePatterns: false, useStructure: false })],
  ["full_without_confidence_threshold", { ...currentStrategy, config: { ...currentStrategy.config, entry: { ...currentStrategy.config.entry, minConfidence: 0 } } }],
  ["full_without_trailing", trailingDisabledStrategy],
  ["full_zero_costs", currentStrategy],
  ["full_realistic_costs", currentStrategy],
] as const;
const ablationResults: Record<string, ReturnType<typeof summary>> = {};
for (const [name, strategy] of ablations) {
  const config = name === "full_zero_costs"
    ? { ...baseConfig, spreadPoints: 0, slippagePoints: 0, commissionPerLot: 0 }
    : baseConfig;
  ablationResults[name] = summary(runBacktest(strategy as never, symbol, h1, config, options));
}
ablationResults.reversed_directions_diagnostic = summary(runBacktest(
  currentStrategy as never,
  symbol,
  h1,
  baseConfig,
  { ...options, reverseSignals: true },
));

const allCosts = stagedCosts.allCosts;
const selected = [
  ...chooseAcross(allCosts.trades.filter((trade) => trade.netPnl > 0), 10),
  ...chooseAcross(allCosts.trades.filter((trade) => trade.netPnl <= 0), 10),
].slice(0, 20);
const byTime = new Map(h1.map((candle, index) => [new Date(candle.time).toISOString(), index]));
const validation = selected.map((trade) => {
  const signalIndex = byTime.get(new Date(trade.signalTime).toISOString()) ?? -1;
  const entryIndex = byTime.get(new Date(trade.entryTime).toISOString()) ?? -1;
  const signalWindow = signalIndex >= 0 ? h1.slice(Math.max(0, signalIndex - 199), signalIndex + 1) : [];
  const closes = signalWindow.map((candle) => candle.close);
  const rsi = independentRsi(closes);
  const macd = independentMacd(closes);
  const atr = independentAtr(signalWindow);
  const spread = baseConfig.spreadPoints * instrument.point;
  const slippage = baseConfig.slippagePoints * instrument.point;
  const entryBar = entryIndex >= 0 ? h1[entryIndex] : null;
  const expectedEntry = entryBar
    ? trade.direction === "buy" ? entryBar.open + spread + slippage : entryBar.open - slippage
    : Number.NaN;
  const expectedGross = moneyForPriceMove(
    trade.direction === "buy" ? trade.exitPrice - trade.entryPrice : trade.entryPrice - trade.exitPrice,
    trade.lotSize,
    instrument,
  );
  const expectedNet = expectedGross - trade.commission;
  const expectedLot = independentLotSize(trade, instrument);
  const comparisons = {
    nextBarIndexDifference: entryIndex - signalIndex,
    entryPrice: { expected: expectedEntry, actual: trade.entryPrice, difference: trade.entryPrice - expectedEntry },
    atr: { expected: atr, actual: trade.atr, difference: atr === null ? null : trade.atr - atr },
    stopDistance: { expected: Math.max((atr ?? trade.atr) * 1.5, instrument.stopsLevelPoints * instrument.point), actual: Math.abs(trade.entryPrice - trade.stopLoss) },
    targetDistance: { expected: Math.max((atr ?? trade.atr) * 2.4, instrument.stopsLevelPoints * instrument.point), actual: Math.abs(trade.takeProfit - trade.entryPrice) },
    lotSize: { expected: expectedLot, actual: trade.lotSize, difference: trade.lotSize - expectedLot },
    rsiPrevious: { expected: rsi.at(-2) ?? null, actual: trade.rsiPrevious },
    rsiCurrent: { expected: rsi.at(-1) ?? null, actual: trade.rsiCurrent },
    macdPrevious: { expected: macd.line.at(-2) ?? null, actual: trade.macdPrevious },
    macdCurrent: { expected: macd.line.at(-1) ?? null, actual: trade.macdCurrent },
    signalPrevious: { expected: macd.signal.at(-2) ?? null, actual: trade.signalPrevious },
    signalCurrent: { expected: macd.signal.at(-1) ?? null, actual: trade.signalCurrent },
    grossPnl: { expected: expectedGross, actual: trade.grossPnl, difference: trade.grossPnl - expectedGross },
    netPnl: { expected: expectedNet, actual: trade.netPnl, difference: trade.netPnl - expectedNet },
  };
  const maxDifference = Math.max(
    Math.abs(comparisons.entryPrice.difference || 0),
    Math.abs(comparisons.lotSize.difference || 0),
    Math.abs(comparisons.grossPnl.difference || 0),
    Math.abs(comparisons.netPnl.difference || 0),
  );
  return {
    signalTime: trade.signalTime,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    direction: trade.direction,
    exitReason: trade.exitReason,
    signalCandle: signalIndex >= 0 ? h1[signalIndex] : null,
    entryCandle: entryBar,
    comparisons,
    rootCause: maxDifference <= 0.011 && comparisons.nextBarIndexDifference === 1 ? "none" : "discrepancy requires investigation",
    fix: maxDifference <= 0.011 && comparisons.nextBarIndexDifference === 1 ? "none" : "inspect the reported field differences",
  };
});

const result = {
  generatedAt: new Date().toISOString(),
  symbol,
  data: {
    tickTime: tick.time,
    primaryBars: h1.length,
    higherTimeframeBars: h4.length,
    from: h1[0]?.time,
    to: h1.at(-1)?.time,
    instrument,
  },
  stagedCosts: Object.fromEntries(Object.entries(stagedCosts).map(([name, value]) => [name, summary(value)])),
  trailingComparison: {
    enabled: summary(allCosts),
    disabled: summary(trailingDisabled),
  },
  sameBarComparison: {
    stopFirst: summary(allCosts),
    tpFirst: summary(tpFirst),
    affectedTrades: allCosts.stats.sameBarAmbiguousExitCount,
    affectedPct: allCosts.stats.trades ? Number((allCosts.stats.sameBarAmbiguousExitCount / allCosts.stats.trades * 100).toFixed(2)) : 0,
    tpFirstNetEffect: Number((tpFirst.stats.totalPnl - allCosts.stats.totalPnl).toFixed(2)),
  },
  walkForward,
  ablations: ablationResults,
  independentValidation: validation,
  diagnostics: allCosts.trades,
};

const json = JSON.stringify(result, null, 2);
if (outputPath) await writeFile(outputPath, json, "utf8");
else process.stdout.write(json);
