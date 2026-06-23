import type {
  BacktestEquityPoint,
  BacktestStats,
  BacktestTrade,
  GroupedBacktestResult,
} from "./types.js";

type MetricTrade = Pick<
  BacktestTrade,
  | "entryTime" | "exitTime" | "direction" | "netPnl" | "grossPnl" | "rMultiple"
  | "exitReason" | "sameBarAmbiguous" | "spreadCost" | "commission" | "slippageCost"
  | "session" | "confidence"
>;

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function profitFactor(values: number[]): number | null {
  const gains = values.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
  const losses = Math.abs(values.filter((v) => v < 0).reduce((sum, v) => sum + v, 0));
  if (losses > 0) return round(gains / losses);
  return gains > 0 ? null : 0;
}

function grouped(
  trades: MetricTrade[],
  keyFor: (trade: MetricTrade) => string,
): GroupedBacktestResult[] {
  const groups = new Map<string, MetricTrade[]>();
  for (const trade of trades) {
    const key = keyFor(trade);
    const values = groups.get(key) ?? [];
    values.push(trade);
    groups.set(key, values);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => {
    const pnls = values.map((trade) => trade.netPnl);
    const wins = pnls.filter((pnl) => pnl > 0).length;
    const losses = pnls.filter((pnl) => pnl < 0).length;
    return {
      key,
      trades: values.length,
      wins,
      losses,
      winRate: values.length ? round((wins / values.length) * 100, 1) : null,
      totalPnl: round(pnls.reduce((sum, pnl) => sum + pnl, 0)),
      profitFactor: profitFactor(pnls),
      averagePnl: values.length ? round(pnls.reduce((sum, pnl) => sum + pnl, 0) / values.length) : null,
    };
  });
}

function maxStreak(values: number[], predicate: (value: number) => boolean): number {
  let current = 0;
  let maximum = 0;
  for (const value of values) {
    current = predicate(value) ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function directionMetrics(trades: MetricTrade[], direction: "buy" | "sell") {
  const selected = trades.filter((trade) => trade.direction === direction);
  const wins = selected.filter((trade) => trade.netPnl > 0).length;
  return {
    count: selected.length,
    winRate: selected.length ? round((wins / selected.length) * 100, 1) : null,
    profitFactor: profitFactor(selected.map((trade) => trade.netPnl)),
  };
}

export function calculateBacktestStats(
  trades: MetricTrade[],
  initialBalance: number,
  equityCurve: BacktestEquityPoint[],
): BacktestStats {
  const pnls = trades.map((trade) => trade.netPnl);
  const winners = trades.filter((trade) => trade.netPnl > 0);
  const losers = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.netPnl, 0));
  const totalPnl = pnls.reduce((sum, pnl) => sum + pnl, 0);
  const averageWinner = winners.length ? grossProfit / winners.length : null;
  const averageLoser = losers.length ? grossLoss / losers.length : null;
  const averageWinningR = winners.length
    ? winners.reduce((sum, trade) => sum + trade.rMultiple, 0) / winners.length
    : null;
  const averageLosingR = losers.length
    ? losers.reduce((sum, trade) => sum + trade.rMultiple, 0) / losers.length
    : null;
  const payoffRatio = averageWinner !== null && averageLoser ? averageWinner / averageLoser : null;
  const breakEvenWinRate = payoffRatio !== null ? 100 / (1 + payoffRatio) : null;
  const holdingMinutes = trades.map((trade) =>
    Math.max(0, (Date.parse(trade.exitTime) - Date.parse(trade.entryTime)) / 60_000));
  const long = directionMetrics(trades, "buy");
  const short = directionMetrics(trades, "sell");

  let peak = initialBalance;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equity) / peak) * 100);
  }

  const dailyEnds = new Map<string, number>();
  for (const point of equityCurve) dailyEnds.set(point.time.slice(0, 10), point.equity);
  const dailyReturns: number[] = [];
  let previous = initialBalance;
  for (const equity of dailyEnds.values()) {
    if (previous > 0) dailyReturns.push(equity / previous - 1);
    previous = equity;
  }
  const meanReturn = dailyReturns.length
    ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
    : 0;
  const returnSd = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const finalBalance = equityCurve.at(-1)?.balance ?? initialBalance + totalPnl;
  const confidenceBucket = (trade: MetricTrade) => {
    if (trade.confidence < 0.7) return "<0.70";
    if (trade.confidence < 0.8) return "0.70-0.79";
    if (trade.confidence < 0.9) return "0.80-0.89";
    return ">=0.90";
  };

  return {
    trades: trades.length,
    wins: winners.length,
    losses: losers.length,
    winRate: trades.length ? round((winners.length / trades.length) * 100, 1) : null,
    profitFactor: profitFactor(pnls),
    expectancy: trades.length ? round(totalPnl / trades.length) : null,
    totalPnl: round(totalPnl),
    returnPct: initialBalance > 0 ? round((totalPnl / initialBalance) * 100) : 0,
    maxDrawdownPct: round(maxDrawdownPct),
    maxLossStreak: maxStreak(pnls, (value) => value < 0),
    maxConsecutiveWins: maxStreak(pnls, (value) => value > 0),
    maxConsecutiveLosses: maxStreak(pnls, (value) => value < 0),
    avgWin: averageWinner === null ? null : round(averageWinner),
    avgLoss: averageLoser === null ? null : round(averageLoser),
    averageWinner: averageWinner === null ? null : round(averageWinner),
    averageLoser: averageLoser === null ? null : round(averageLoser),
    averageWinningR: averageWinningR === null ? null : round(averageWinningR),
    averageLosingR: averageLosingR === null ? null : round(averageLosingR),
    payoffRatio: payoffRatio === null ? null : round(payoffRatio),
    breakEvenWinRate: breakEvenWinRate === null ? null : round(breakEvenWinRate),
    largestWinner: winners.length ? round(Math.max(...winners.map((trade) => trade.netPnl))) : null,
    largestLoser: losers.length ? round(Math.min(...losers.map((trade) => trade.netPnl))) : null,
    sharpe: returnSd > 0 ? round((meanReturn / returnSd) * Math.sqrt(252)) : null,
    finalBalance: round(finalBalance),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    longTradeCount: long.count,
    shortTradeCount: short.count,
    longWinRate: long.winRate,
    shortWinRate: short.winRate,
    longProfitFactor: long.profitFactor,
    shortProfitFactor: short.profitFactor,
    averageHoldingMinutes: holdingMinutes.length ? round(holdingMinutes.reduce((sum, value) => sum + value, 0) / holdingMinutes.length) : null,
    medianHoldingMinutes: median(holdingMinutes) === null ? null : round(median(holdingMinutes) as number),
    stopLossExitCount: trades.filter((trade) => trade.exitReason === "sl").length,
    takeProfitExitCount: trades.filter((trade) => trade.exitReason === "tp").length,
    trailingStopExitCount: trades.filter((trade) => trade.exitReason === "trail").length,
    breakEvenExitCount: trades.filter((trade) => trade.exitReason === "break_even").length,
    endOfTestExitCount: trades.filter((trade) => trade.exitReason === "end").length,
    sameBarAmbiguousExitCount: trades.filter((trade) => trade.sameBarAmbiguous).length,
    totalSpreadCost: round(trades.reduce((sum, trade) => sum + trade.spreadCost, 0)),
    totalCommission: round(trades.reduce((sum, trade) => sum + trade.commission, 0)),
    totalSlippage: round(trades.reduce((sum, trade) => sum + trade.slippageCost, 0)),
    monthlyResults: grouped(trades, (trade) => trade.entryTime.slice(0, 7)),
    sessionResults: grouped(trades, (trade) => trade.session),
    dayOfWeekResults: grouped(trades, (trade) => new Date(trade.entryTime).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })),
    confidenceBucketResults: grouped(trades, confidenceBucket),
  };
}
