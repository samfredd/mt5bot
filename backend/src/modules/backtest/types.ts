import type { BacktestDirection, BacktestExitReason, SameBarPolicy } from "./execution.js";
import type { TradingInstrumentSpec } from "../risk/instruments.js";

export interface BacktestConfig {
  initialBalance: number;
  spreadPoints: number;
  slippagePoints: number;
  /** Round-turn commission in account currency per lot. */
  commissionPerLot: number;
  maxLotSize: number;
  sameBarPolicy?: SameBarPolicy;
  instrument?: TradingInstrumentSpec;
}

export interface BacktestTrade {
  signalTime: string;
  entryTime: string;
  exitTime: string;
  symbol: string;
  timeframe: string;
  direction: BacktestDirection;
  entryPrice: number;
  exitPrice: number;
  bidAtEntry: number;
  askAtEntry: number;
  bidAtExit: number;
  askAtExit: number;
  spreadPoints: number;
  slippagePoints: number;
  commission: number;
  atr: number;
  stopLoss: number;
  takeProfit: number;
  initialRiskAmount: number;
  lotSize: number;
  h4Trend: string;
  rsiPrevious: number | null;
  rsiCurrent: number | null;
  macdPrevious: number | null;
  macdCurrent: number | null;
  signalPrevious: number | null;
  signalCurrent: number | null;
  candlePattern: string | null;
  confidence: number;
  trailingActivatedAt: string | null;
  maximumFavorableExcursion: number;
  maximumAdverseExcursion: number;
  exitReason: BacktestExitReason;
  sameBarAmbiguous: boolean;
  grossPnl: number;
  netPnl: number;
  rMultiple: number;
  grossRMultiple: number;
  spreadCost: number;
  slippageCost: number;
  balanceBefore: number;
  balanceAfter: number;
  session: string;
  reasons: string[];
  // Backward-compatible aliases used by the existing UI.
  openTime: string;
  closeTime: string;
  lots: number;
  entry: number;
  exit: number;
  sl: number;
  tp: number;
  profit: number;
}

export interface BacktestEquityPoint {
  time: string;
  balance: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface PercentileRange {
  p05: number;
  p50: number;
  p95: number;
}

export interface MonteCarloResult {
  iterations: number;
  seed: number;
  tradeCount: number;
  returnPct: PercentileRange;
  finalBalance: PercentileRange;
  maxDrawdownPct: PercentileRange;
}

export interface GroupedBacktestResult {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  profitFactor: number | null;
  averagePnl: number | null;
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  totalPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  maxLossStreak: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgWin: number | null;
  avgLoss: number | null;
  averageWinner: number | null;
  averageLoser: number | null;
  averageWinningR: number | null;
  averageLosingR: number | null;
  payoffRatio: number | null;
  breakEvenWinRate: number | null;
  largestWinner: number | null;
  largestLoser: number | null;
  sharpe: number | null;
  finalBalance: number;
  grossProfit: number;
  grossLoss: number;
  longTradeCount: number;
  shortTradeCount: number;
  longWinRate: number | null;
  shortWinRate: number | null;
  longProfitFactor: number | null;
  shortProfitFactor: number | null;
  averageHoldingMinutes: number | null;
  medianHoldingMinutes: number | null;
  stopLossExitCount: number;
  takeProfitExitCount: number;
  trailingStopExitCount: number;
  breakEvenExitCount: number;
  endOfTestExitCount: number;
  sameBarAmbiguousExitCount: number;
  totalSpreadCost: number;
  totalCommission: number;
  totalSlippage: number;
  monthlyResults: GroupedBacktestResult[];
  sessionResults: GroupedBacktestResult[];
  dayOfWeekResults: GroupedBacktestResult[];
  confidenceBucketResults: GroupedBacktestResult[];
}
