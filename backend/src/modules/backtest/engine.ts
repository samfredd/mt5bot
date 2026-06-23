import type { Strategy } from "@prisma/client";
import type { Candle } from "../mt5/client.js";
import { analyzeTimeframe, asianRange, detectSession, type MarketAnalysis } from "../analysis/engine.js";
import { atr, last } from "../analysis/indicators.js";
import { deriveLevels, evaluateStrategy } from "../strategy/service.js";
import { calculateLots } from "../risk/engine.js";
import {
  fallbackTradingSpec,
  moneyForPriceMove,
  priceDistanceFromPoints,
} from "../risk/instruments.js";
import {
  closeAtMarket,
  enterPosition,
  ratchetStop,
  resolveBar,
  type ExecutionConfig,
  type OpenBacktestPosition,
} from "./execution.js";
import {
  aggregateCandles,
  candlesVisibleAt,
  distinctValidCount,
  normalizeCandles,
  timeframeMinutes,
} from "./market-data.js";
import { calculateBacktestStats } from "./metrics.js";
import type {
  BacktestConfig,
  BacktestEquityPoint,
  BacktestStats,
  BacktestTrade,
} from "./types.js";

export { aggregateCandles } from "./market-data.js";
export type { BacktestConfig, BacktestTrade } from "./types.js";

const WINDOW = 200;

export interface BacktestOptions {
  timeframeCandles?: Record<string, Candle[]>;
  asOfMs?: number;
  tradeStartMs?: number;
  tradeEndMs?: number;
  brokerAlignmentOffsetMinutes?: number;
  reverseSignals?: boolean;
}

export interface BacktestResult {
  symbol: string;
  timeframe: string;
  bars: number;
  from: string;
  to: string;
  config: BacktestConfig;
  trades: BacktestTrade[];
  stats: BacktestStats;
  equityCurve: BacktestEquityPoint[];
  warnings: string[];
  dataQuality: {
    inputBars: number;
    normalizedBars: number;
    duplicatesRemoved: number;
    outOfOrderBars: number;
  };
}

interface SignalSnapshot {
  direction: "buy" | "sell";
  signalTime: string;
  atr: number;
  stopDistance: number;
  targetDistance: number;
  reasons: string[];
  confidence: number;
  h4Trend: string;
  rsiPrevious: number | null;
  rsiCurrent: number | null;
  macdPrevious: number | null;
  macdCurrent: number | null;
  signalPrevious: number | null;
  signalCurrent: number | null;
  candlePattern: string | null;
  session: string;
  trailingEnabled: boolean;
  lotSizing: { method: "fixed" | "risk_pct"; fixedLots: number; riskPct: number };
  stopLossAtrMult: number;
  takeProfitAtrMult: number;
}

interface PendingEntry {
  entryTime: string;
  snapshot: SignalSnapshot;
}

const money = (value: number) => Number(value.toFixed(2));

function countOutOfOrder(candles: Candle[]): number {
  let count = 0;
  for (let i = 1; i < candles.length; i++) {
    if (Date.parse(candles[i].time) <= Date.parse(candles[i - 1].time)) count++;
  }
  return count;
}

function downsampleCurve(curve: BacktestEquityPoint[]): BacktestEquityPoint[] {
  if (curve.length <= 500) return curve;
  const step = Math.max(1, Math.floor(curve.length / 499));
  const sampled = curve.filter((_, index) => index % step === 0);
  const last = curve.at(-1);
  if (last && sampled.at(-1)?.time !== last.time) sampled.push(last);
  return sampled;
}

function updateExcursions(
  position: OpenBacktestPosition,
  bar: Candle,
  spread: number,
): OpenBacktestPosition {
  const favorable = position.direction === "buy"
    ? Math.max(0, bar.high - position.entryPrice)
    : Math.max(0, position.entryPrice - (bar.low + spread));
  const adverse = position.direction === "buy"
    ? Math.max(0, position.entryPrice - bar.low)
    : Math.max(0, bar.high + spread - position.entryPrice);
  return {
    ...position,
    maximumFavorableExcursion: Math.max(position.maximumFavorableExcursion, favorable),
    maximumAdverseExcursion: Math.max(position.maximumAdverseExcursion, adverse),
  };
}

export function runBacktest(
  strategy: Pick<Strategy, "id" | "name" | "config">,
  symbol: string,
  primaryCandles: Candle[],
  cfg: BacktestConfig,
  options: BacktestOptions = {},
): BacktestResult {
  const warnings = [
    "AI veto and confidence are not simulated; minConfidence remains a live AI gate, so this is the deterministic pre-AI strategy.",
    "Historical news pauses and news-driven lot reductions are not simulated.",
    "Live account-wide risk gates are not simulated beyond strategy maxTradesPerDay and maxLotSize.",
    "Swap/overnight financing is not modeled.",
    "ATR trailing is evaluated on completed candle closes; live management can ratchet intrabar on scheduler ticks.",
  ];
  const strategyConfig = strategy.config as {
    timeframes?: string[];
    maxTradesPerDay?: number;
  };
  const timeframes = strategyConfig.timeframes?.length ? strategyConfig.timeframes : ["M15", "H1"];
  const primaryTf = timeframes[0];
  const primaryMinutes = timeframeMinutes(primaryTf);
  const asOfMs = options.asOfMs ?? Number.POSITIVE_INFINITY;
  const rawPrimary = options.timeframeCandles?.[primaryTf] ?? primaryCandles;
  const candles = normalizeCandles(rawPrimary, primaryTf, asOfMs);
  const instrument = cfg.instrument ?? fallbackTradingSpec(symbol, candles[0]?.close ?? 1);
  const executionConfig: ExecutionConfig = {
    instrument,
    spreadPoints: cfg.spreadPoints,
    slippagePoints: cfg.slippagePoints,
    commissionPerLot: cfg.commissionPerLot,
    sameBarPolicy: cfg.sameBarPolicy ?? "stop_first",
  };
  const spread = priceDistanceFromPoints(cfg.spreadPoints, instrument);
  const series: Record<string, Candle[]> = { [primaryTf]: candles };

  for (const timeframe of timeframes.slice(1)) {
    const supplied = options.timeframeCandles?.[timeframe];
    if (supplied?.length) {
      series[timeframe] = normalizeCandles(supplied, timeframe, asOfMs);
    } else {
      const minutes = timeframeMinutes(timeframe);
      series[timeframe] = minutes > primaryMinutes
        ? aggregateCandles(candles, primaryMinutes, minutes, options.brokerAlignmentOffsetMinutes ?? 0)
        : candles;
      warnings.push(`No broker ${timeframe} series supplied; aggregated ${primaryTf} using offset ${options.brokerAlignmentOffsetMinutes ?? 0} minutes.`);
    }
  }

  const strategyRow = {
    ...strategy,
    userId: "",
    type: "",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Strategy;
  const tradeStartMs = options.tradeStartMs ?? Number.NEGATIVE_INFINITY;
  const tradeEndMs = options.tradeEndMs ?? Number.POSITIVE_INFINITY;
  const maxTradesPerDay = strategyConfig.maxTradesPerDay ?? 5;
  const tradesPerDay = new Map<string, number>();
  const trades: BacktestTrade[] = [];
  const equityCurve: BacktestEquityPoint[] = [];
  let balance = cfg.initialBalance;
  let open: (OpenBacktestPosition & { snapshot: SignalSnapshot }) | null = null;
  let pending: PendingEntry | null = null;

  const appendClosedTrade = (
    position: OpenBacktestPosition & { snapshot: SignalSnapshot },
    exit: ReturnType<typeof closeAtMarket>,
  ) => {
    const grossPnl = money(exit.grossPnl);
    const commission = money(exit.commission);
    const netPnl = money(grossPnl - commission);
    const balanceBefore = balance;
    balance = money(balance + netPnl);
    const trade: BacktestTrade = {
      signalTime: position.signalTime,
      entryTime: position.entryTime,
      exitTime: exit.exitTime,
      symbol,
      timeframe: primaryTf,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice: exit.exitPrice,
      bidAtEntry: position.bidAtEntry,
      askAtEntry: position.askAtEntry,
      bidAtExit: exit.bidAtExit,
      askAtExit: exit.askAtExit,
      spreadPoints: cfg.spreadPoints,
      slippagePoints: cfg.slippagePoints,
      commission,
      atr: position.atr,
      stopLoss: position.originalStopLoss,
      takeProfit: position.takeProfit,
      initialRiskAmount: money(position.initialRiskAmount),
      lotSize: position.lots,
      h4Trend: position.snapshot.h4Trend,
      rsiPrevious: position.snapshot.rsiPrevious,
      rsiCurrent: position.snapshot.rsiCurrent,
      macdPrevious: position.snapshot.macdPrevious,
      macdCurrent: position.snapshot.macdCurrent,
      signalPrevious: position.snapshot.signalPrevious,
      signalCurrent: position.snapshot.signalCurrent,
      candlePattern: position.snapshot.candlePattern,
      confidence: position.snapshot.confidence,
      trailingActivatedAt: position.trailingActivatedAt,
      maximumFavorableExcursion: position.maximumFavorableExcursion,
      maximumAdverseExcursion: position.maximumAdverseExcursion,
      exitReason: exit.exitReason,
      sameBarAmbiguous: exit.sameBarAmbiguous,
      grossPnl,
      netPnl,
      rMultiple: position.initialRiskAmount > 0 ? Number((netPnl / position.initialRiskAmount).toFixed(4)) : 0,
      grossRMultiple: position.initialRiskAmount > 0 ? Number((grossPnl / position.initialRiskAmount).toFixed(4)) : 0,
      spreadCost: money(exit.spreadCost),
      slippageCost: money(exit.slippageCost),
      balanceBefore,
      balanceAfter: balance,
      session: position.snapshot.session,
      reasons: position.snapshot.reasons,
      openTime: position.entryTime,
      closeTime: exit.exitTime,
      lots: position.lots,
      entry: position.entryPrice,
      exit: exit.exitPrice,
      sl: position.originalStopLoss,
      tp: position.takeProfit,
      profit: netPnl,
    };
    trades.push(trade);
  };

  for (let i = WINDOW - 1; i < candles.length; i++) {
    const bar = candles[i];
    const barTimeMs = Date.parse(bar.time);
    const barCloseMs = barTimeMs + primaryMinutes * 60_000;

    if (pending && pending.entryTime === bar.time && !open) {
      const snapshot = pending.snapshot;
      const provisional = enterPosition({
        symbol,
        timeframe: primaryTf,
        signalTime: snapshot.signalTime,
        entryBar: bar,
        direction: snapshot.direction,
        atr: snapshot.atr,
        stopLossAtrMult: snapshot.stopLossAtrMult,
        takeProfitAtrMult: snapshot.takeProfitAtrMult,
        stopDistance: snapshot.stopDistance,
        targetDistance: snapshot.targetDistance,
        lots: 1,
        trailingEnabled: snapshot.trailingEnabled,
        balanceBefore: balance,
        config: executionConfig,
      });
      const lots = snapshot.lotSizing.method === "fixed"
        ? Math.min(snapshot.lotSizing.fixedLots, cfg.maxLotSize, instrument.volumeMax)
        : calculateLots(symbol, balance, snapshot.lotSizing.riskPct, provisional.entryPrice, provisional.stopLoss, cfg.maxLotSize, instrument);
      if (lots > 0) {
        // The provisional was sized at 1 lot; entry/stop prices are lot-
        // independent and only risk/slippage scale linearly with volume —
        // so scale instead of re-running enterPosition (bit-identical result).
        open = {
          ...provisional,
          lots,
          initialRiskAmount: provisional.initialRiskAmount * lots,
          entrySlippageCost: provisional.entrySlippageCost * lots,
          snapshot,
        };
        const day = bar.time.slice(0, 10);
        tradesPerDay.set(day, (tradesPerDay.get(day) ?? 0) + 1);
      }
      pending = null;
    }

    if (open) {
      open = { ...updateExcursions(open, bar, spread), snapshot: open.snapshot };
      const exit = resolveBar(open, bar, executionConfig);
      if (exit) {
        appendClosedTrade(open, exit);
        open = null;
      } else {
        // Management only needs ATR — compute it directly instead of running
        // the full indicator suite (RSI/MACD/BB/ADX/patterns) every bar. Same
        // window and math as analyzeTimeframe(...).atr, so results are identical.
        const w = candles.slice(Math.max(0, i - WINDOW + 1), i + 1);
        const managementAtr = last(atr(w.map((c) => c.high), w.map((c) => c.low), w.map((c) => c.close), 14)) ?? null;
        const executableClose = open.direction === "buy" ? bar.close : bar.close + spread;
        const ratcheted = ratchetStop(open, executableClose, managementAtr, bar.time);
        open = { ...ratcheted.position, snapshot: open.snapshot };
      }
    }

    const nextBar = candles[i + 1];
    if (!open && !pending && nextBar) {
      const nextEntryMs = Date.parse(nextBar.time);
      const nextDay = nextBar.time.slice(0, 10);
      const allowedByWindow = nextEntryMs >= tradeStartMs && nextEntryMs < tradeEndMs;
      const allowedByCount = (tradesPerDay.get(nextDay) ?? 0) < maxTradesPerDay;
      if (allowedByWindow && allowedByCount) {
        const primaryWindow = candles.slice(i - WINDOW + 1, i + 1);
        const primaryAnalysis = analyzeTimeframe(primaryTf, primaryWindow);
        const timeframeAnalyses = [primaryAnalysis];
        for (const timeframe of timeframes.slice(1)) {
          const visible = candlesVisibleAt(series[timeframe], timeframe, barCloseMs, WINDOW);
          if (visible.length >= 60) timeframeAnalyses.push(analyzeTimeframe(timeframe, visible));
        }
        const analysis: MarketAnalysis = {
          symbol,
          generatedAt: new Date(barCloseMs).toISOString(),
          spreadPoints: cfg.spreadPoints,
          bid: bar.close,
          ask: bar.close + spread,
          session: detectSession(new Date(nextEntryMs)),
          timeframes: timeframeAnalyses,
          summary: "",
          referenceRange: asianRange(primaryWindow, barCloseMs),
        };
        const signal = evaluateStrategy(strategyRow, analysis);
        let direction = signal.direction;
        if (direction && options.reverseSignals) direction = direction === "buy" ? "sell" : "buy";
        if (direction) {
          const effectiveSignal = { ...signal, direction };
          const levels = deriveLevels(effectiveSignal, analysis);
          if (levels && primaryAnalysis.atr) {
            const higher = timeframeAnalyses.at(-1);
            pending = {
              entryTime: nextBar.time,
              snapshot: {
                direction,
                signalTime: bar.time,
                atr: primaryAnalysis.atr,
                stopDistance: Math.abs(levels.entry - levels.stopLoss),
                targetDistance: Math.abs(levels.takeProfit - levels.entry),
                reasons: signal.reasons,
                confidence: signal.confidence,
                h4Trend: higher && higher !== primaryAnalysis ? higher.trend : "unavailable",
                rsiPrevious: primaryAnalysis.rsiPrevious,
                rsiCurrent: primaryAnalysis.rsi,
                macdPrevious: primaryAnalysis.macdPrevious,
                macdCurrent: primaryAnalysis.macdCurrent,
                signalPrevious: primaryAnalysis.signalPrevious,
                signalCurrent: primaryAnalysis.signalCurrent,
                candlePattern: primaryAnalysis.candlePattern,
                session: analysis.session,
                trailingEnabled: signal.config.exit.trailingStop,
                lotSizing: signal.config.lotSizing,
                stopLossAtrMult: signal.config.exit.stopLossAtrMult,
                takeProfitAtrMult: signal.config.exit.takeProfitAtrMult,
              },
            };
          }
        }
      }
    }

    if (barTimeMs >= tradeStartMs && barTimeMs < tradeEndMs) {
      let unrealizedPnl = 0;
      if (open) {
        const executableClose = open.direction === "buy" ? bar.close : bar.close + spread;
        const move = open.direction === "buy"
          ? executableClose - open.entryPrice
          : open.entryPrice - executableClose;
        unrealizedPnl = moneyForPriceMove(move, open.lots, instrument) - cfg.commissionPerLot * open.lots;
      }
      equityCurve.push({
        time: bar.time,
        balance,
        equity: money(balance + unrealizedPnl),
        realizedPnl: money(balance - cfg.initialBalance),
        unrealizedPnl: money(unrealizedPnl),
      });
    }
  }

  if (open) {
    const last = [...candles].reverse().find((candle) => Date.parse(candle.time) < tradeEndMs) ?? candles.at(-1);
    if (last) {
      appendClosedTrade(open, closeAtMarket(open, last, executionConfig, "end"));
      const finalPoint: BacktestEquityPoint = {
        time: last.time,
        balance,
        equity: balance,
        realizedPnl: money(balance - cfg.initialBalance),
        unrealizedPnl: 0,
      };
      if (equityCurve.at(-1)?.time === last.time) equityCurve[equityCurve.length - 1] = finalPoint;
      else equityCurve.push(finalPoint);
    }
  }

  if (!equityCurve.length && candles.length) {
    const last = candles.at(-1)!;
    equityCurve.push({ time: last.time, balance, equity: balance, realizedPnl: 0, unrealizedPnl: 0 });
  }
  const finalPoint = equityCurve.at(-1);
  if (finalPoint && finalPoint.equity !== balance) {
    equityCurve[equityCurve.length - 1] = {
      ...finalPoint,
      balance,
      equity: balance,
      realizedPnl: money(balance - cfg.initialBalance),
      unrealizedPnl: 0,
    };
  }

  const reportCandles = candles.filter((candle) => {
    const time = Date.parse(candle.time);
    return time >= tradeStartMs && time < tradeEndMs;
  });
  const stats = calculateBacktestStats(trades, cfg.initialBalance, equityCurve);

  return {
    symbol,
    timeframe: primaryTf,
    bars: reportCandles.length || candles.length,
    from: reportCandles[0]?.time ?? candles[0]?.time ?? "",
    to: reportCandles.at(-1)?.time ?? candles.at(-1)?.time ?? "",
    config: cfg,
    trades,
    stats,
    equityCurve: downsampleCurve(equityCurve),
    warnings,
    dataQuality: {
      inputBars: rawPrimary.length,
      normalizedBars: candles.length,
      duplicatesRemoved: Math.max(0, rawPrimary.length - distinctValidCount(rawPrimary)),
      outOfOrderBars: countOutOfOrder(rawPrimary),
    },
  };
}

export interface WalkForwardFold {
  fold: number;
  from: string;
  to: string;
  bars: number;
  trades: number;
  returnPct: number;
  profitFactor: number | null;
  winRate: number | null;
  maxDrawdownPct: number;
  expectancy: number | null;
}

export interface WalkForwardResult {
  symbol: string;
  timeframe: string;
  folds: WalkForwardFold[];
  consistency: {
    foldCount: number;
    profitableFolds: number;
    profitableFraction: number;
    meanReturnPct: number;
    stdevReturnPct: number;
    worstReturnPct: number;
    bestReturnPct: number;
    totalTrades: number;
    avgProfitFactor: number | null;
    verdict: string;
  };
  warnings: string[];
}

export function runWalkForward(
  strategy: Pick<Strategy, "id" | "name" | "config">,
  symbol: string,
  inputCandles: Candle[],
  cfg: BacktestConfig,
  folds = 4,
  options: Omit<BacktestOptions, "tradeStartMs" | "tradeEndMs"> = {},
): WalkForwardResult {
  const strategyConfig = strategy.config as { timeframes?: string[] };
  const primaryTf = strategyConfig.timeframes?.[0] ?? "H1";
  const candles = normalizeCandles(inputCandles, primaryTf, options.asOfMs ?? Number.POSITIVE_INFINITY);
  const n = Math.max(2, Math.min(Math.floor(folds), 12));
  const sliceSize = Math.floor(candles.length / n);
  const out: WalkForwardFold[] = [];
  const returns: number[] = [];
  const profitFactors: number[] = [];
  let totalTrades = 0;

  for (let fold = 0; fold < n; fold++) {
    const start = fold * sliceSize;
    const end = fold === n - 1 ? candles.length : start + sliceSize;
    if (end - start < 30) continue;
    const warmupStart = Math.max(0, start - WINDOW);
    const slice = candles.slice(warmupStart, end);
    if (slice.length < WINDOW + 1) continue;
    const tradeStartMs = Date.parse(candles[start].time);
    const tradeEndMs = Date.parse(candles[end - 1].time) + timeframeMinutes(primaryTf) * 60_000;
    const result = runBacktest(strategy, symbol, slice, cfg, {
      ...options,
      tradeStartMs,
      tradeEndMs,
    });
    out.push({
      fold: out.length + 1,
      from: candles[start].time,
      to: candles[end - 1].time,
      bars: end - start,
      trades: result.stats.trades,
      returnPct: result.stats.returnPct,
      profitFactor: result.stats.profitFactor,
      winRate: result.stats.winRate,
      maxDrawdownPct: result.stats.maxDrawdownPct,
      expectancy: result.stats.expectancy,
    });
    returns.push(result.stats.returnPct);
    if (result.stats.profitFactor !== null) profitFactors.push(result.stats.profitFactor);
    totalTrades += result.stats.trades;
  }

  const count = returns.length;
  const profitableFolds = returns.filter((value) => value > 0).length;
  const mean = count ? returns.reduce((sum, value) => sum + value, 0) / count : 0;
  const stdev = count > 1
    ? Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1))
    : 0;
  const profitableFraction = count ? profitableFolds / count : 0;
  const avgProfitFactor = profitFactors.length
    ? Number((profitFactors.reduce((sum, value) => sum + value, 0) / profitFactors.length).toFixed(2))
    : null;
  let verdict: string;
  if (!count) verdict = "Not enough data to split into walk-forward windows.";
  else if (totalTrades < count * 5) verdict = `Too few trades (${totalTrades} across ${count} windows) — the result is noise, not signal.`;
  else if (profitableFraction >= 0.75 && mean > 0) verdict = `Edge looks consistent — profitable in ${profitableFolds}/${count} windows.`;
  else if (profitableFraction >= 0.5 && mean > 0) verdict = `Fragile — profitable in ${profitableFolds}/${count} windows but regime-dependent.`;
  else verdict = `No consistent edge — profitable in only ${profitableFolds}/${count} windows. Do not trade this live.`;

  return {
    symbol,
    timeframe: primaryTf,
    folds: out,
    consistency: {
      foldCount: count,
      profitableFolds,
      profitableFraction: Number(profitableFraction.toFixed(2)),
      meanReturnPct: Number(mean.toFixed(2)),
      stdevReturnPct: Number(stdev.toFixed(2)),
      worstReturnPct: count ? Number(Math.min(...returns).toFixed(2)) : 0,
      bestReturnPct: count ? Number(Math.max(...returns).toFixed(2)) : 0,
      totalTrades,
      avgProfitFactor,
      verdict,
    },
    warnings: [
      "Each fold includes pre-window warm-up candles but cannot enter before the fold starts.",
      "Positions are liquidated at each fold boundary; boundary trades can make fold totals differ slightly from one continuous run.",
      "AI confidence/veto and swap costs are not simulated.",
    ],
  };
}
