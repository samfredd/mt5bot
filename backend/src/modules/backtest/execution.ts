import type { Candle } from "../mt5/client.js";
import {
  moneyForPriceMove,
  priceDistanceFromPoints,
  type TradingInstrumentSpec,
} from "../risk/instruments.js";

export type BacktestDirection = "buy" | "sell";
export type BacktestExitReason = "sl" | "tp" | "break_even" | "trail" | "end";
export type SameBarPolicy = "stop_first" | "tp_first";

export interface ExecutionConfig {
  instrument: TradingInstrumentSpec;
  spreadPoints: number;
  slippagePoints: number;
  /** Round-turn commission in account currency per lot. */
  commissionPerLot: number;
  sameBarPolicy: SameBarPolicy;
}

export interface EnterPositionInput {
  symbol: string;
  timeframe: string;
  signalTime: string;
  entryBar: Candle;
  direction: BacktestDirection;
  atr: number;
  stopLossAtrMult: number;
  takeProfitAtrMult: number;
  stopDistance?: number;
  targetDistance?: number;
  lots: number;
  trailingEnabled: boolean;
  balanceBefore: number;
  config: ExecutionConfig;
}

export interface OpenBacktestPosition {
  symbol: string;
  timeframe: string;
  signalTime: string;
  entryTime: string;
  direction: BacktestDirection;
  lots: number;
  bidAtEntry: number;
  askAtEntry: number;
  entryPrice: number;
  atr: number;
  originalStopLoss: number;
  stopLoss: number;
  takeProfit: number;
  initialRiskAmount: number;
  balanceBefore: number;
  trailingEnabled: boolean;
  breakEvenDone: boolean;
  trailingActivatedAt: string | null;
  maximumFavorableExcursion: number;
  maximumAdverseExcursion: number;
  entrySlippageCost: number;
}

export interface BacktestExit {
  exitTime: string;
  exitPrice: number;
  bidAtExit: number;
  askAtExit: number;
  exitReason: BacktestExitReason;
  sameBarAmbiguous: boolean;
  grossPnl: number;
  commission: number;
  netPnl: number;
  grossRMultiple: number;
  rMultiple: number;
  spreadCost: number;
  slippageCost: number;
}

export interface ManagedStopInput {
  direction: BacktestDirection;
  entryPrice: number;
  originalStopLoss: number;
  currentStopLoss: number;
  executablePrice: number;
  atr: number | null;
  trailingEnabled: boolean;
  breakEvenDone: boolean;
}

export function calculateManagedStop(input: ManagedStopInput): {
  stopLoss: number;
  breakEvenDone: boolean;
  trailingActivated: boolean;
} {
  const initialRiskDistance = Math.abs(input.entryPrice - input.originalStopLoss);
  if (initialRiskDistance <= 0) {
    return { stopLoss: input.currentStopLoss, breakEvenDone: input.breakEvenDone, trailingActivated: false };
  }
  const profitDistance = input.direction === "buy"
    ? input.executablePrice - input.entryPrice
    : input.entryPrice - input.executablePrice;
  const profitR = profitDistance / initialRiskDistance;
  let stopLoss = input.currentStopLoss;
  let breakEvenDone = input.breakEvenDone;
  let trailingActivated = false;

  if (!breakEvenDone && profitR >= 1) {
    const breakEven = input.direction === "buy"
      ? input.entryPrice + 0.1 * initialRiskDistance
      : input.entryPrice - 0.1 * initialRiskDistance;
    if (input.direction === "buy" ? breakEven > stopLoss : breakEven < stopLoss) stopLoss = breakEven;
    breakEvenDone = true;
  }

  if (input.trailingEnabled && profitR >= 1.5 && input.atr && input.atr > 0) {
    const trail = input.direction === "buy"
      ? input.executablePrice - input.atr
      : input.executablePrice + input.atr;
    if (input.direction === "buy" ? trail > stopLoss : trail < stopLoss) {
      stopLoss = trail;
      trailingActivated = true;
    }
  }

  return { stopLoss, breakEvenDone, trailingActivated };
}

function roundPrice(value: number, spec: TradingInstrumentSpec): number {
  return Number(value.toFixed(spec.digits));
}

function spreadDistance(config: ExecutionConfig): number {
  return priceDistanceFromPoints(config.spreadPoints, config.instrument);
}

function slippageDistance(config: ExecutionConfig): number {
  return priceDistanceFromPoints(config.slippagePoints, config.instrument);
}

export function enterPosition(input: EnterPositionInput): OpenBacktestPosition {
  const { config } = input;
  const spread = spreadDistance(config);
  const slippage = slippageDistance(config);
  const bidAtEntry = input.entryBar.open;
  const askAtEntry = bidAtEntry + spread;
  const entryPrice = input.direction === "buy"
    ? askAtEntry + slippage
    : bidAtEntry - slippage;
  const brokerMinimumDistance = priceDistanceFromPoints(config.instrument.stopsLevelPoints, config.instrument);
  const stopDistance = Math.max(
    input.stopDistance ?? input.atr * input.stopLossAtrMult,
    brokerMinimumDistance,
  );
  const targetDistance = Math.max(
    input.targetDistance ?? input.atr * input.takeProfitAtrMult,
    brokerMinimumDistance,
  );
  const stopLoss = input.direction === "buy" ? entryPrice - stopDistance : entryPrice + stopDistance;
  const takeProfit = input.direction === "buy" ? entryPrice + targetDistance : entryPrice - targetDistance;

  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    signalTime: input.signalTime,
    entryTime: input.entryBar.time,
    direction: input.direction,
    lots: input.lots,
    bidAtEntry: roundPrice(bidAtEntry, config.instrument),
    askAtEntry: roundPrice(askAtEntry, config.instrument),
    entryPrice: roundPrice(entryPrice, config.instrument),
    atr: input.atr,
    originalStopLoss: roundPrice(stopLoss, config.instrument),
    stopLoss: roundPrice(stopLoss, config.instrument),
    takeProfit: roundPrice(takeProfit, config.instrument),
    initialRiskAmount: Math.abs(moneyForPriceMove(stopDistance, input.lots, config.instrument)),
    balanceBefore: input.balanceBefore,
    trailingEnabled: input.trailingEnabled,
    breakEvenDone: false,
    trailingActivatedAt: null,
    maximumFavorableExcursion: 0,
    maximumAdverseExcursion: 0,
    entrySlippageCost: Math.abs(moneyForPriceMove(slippage, input.lots, config.instrument)),
  };
}

function buildExit(
  position: OpenBacktestPosition,
  candle: Candle,
  config: ExecutionConfig,
  exitPrice: number,
  reason: BacktestExitReason,
  sameBarAmbiguous: boolean,
  exitSlippageDistance = 0,
): BacktestExit {
  const spread = spreadDistance(config);
  const roundedExit = roundPrice(exitPrice, config.instrument);
  const bidAtExit = position.direction === "buy" ? roundedExit : roundedExit - spread;
  const askAtExit = position.direction === "buy" ? roundedExit + spread : roundedExit;
  const move = position.direction === "buy"
    ? roundedExit - position.entryPrice
    : position.entryPrice - roundedExit;
  const grossPnl = moneyForPriceMove(move, position.lots, config.instrument);
  const commission = config.commissionPerLot * position.lots;
  const netPnl = grossPnl - commission;
  const spreadCost = Math.abs(moneyForPriceMove(spread, position.lots, config.instrument));
  const slippageCost = position.entrySlippageCost +
    Math.abs(moneyForPriceMove(exitSlippageDistance, position.lots, config.instrument));

  return {
    exitTime: candle.time,
    exitPrice: roundedExit,
    bidAtExit: roundPrice(bidAtExit, config.instrument),
    askAtExit: roundPrice(askAtExit, config.instrument),
    exitReason: reason,
    sameBarAmbiguous,
    grossPnl,
    commission,
    netPnl,
    grossRMultiple: position.initialRiskAmount > 0 ? grossPnl / position.initialRiskAmount : 0,
    rMultiple: position.initialRiskAmount > 0 ? netPnl / position.initialRiskAmount : 0,
    spreadCost,
    slippageCost,
  };
}

export function resolveBar(
  position: OpenBacktestPosition,
  candle: Candle,
  config: ExecutionConfig,
): BacktestExit | null {
  const spread = spreadDistance(config);
  const slippage = slippageDistance(config);
  const bidHigh = candle.high;
  const bidLow = candle.low;
  const askHigh = bidHigh + spread;
  const askLow = bidLow + spread;
  const hitStop = position.direction === "buy"
    ? bidLow <= position.stopLoss
    : askHigh >= position.stopLoss;
  const hitTarget = position.direction === "buy"
    ? bidHigh >= position.takeProfit
    : askLow <= position.takeProfit;
  if (!hitStop && !hitTarget) return null;

  const ambiguous = hitStop && hitTarget;
  const stopWins = hitStop && (!hitTarget || config.sameBarPolicy === "stop_first");
  if (stopWins) {
    const price = position.direction === "buy"
      ? position.stopLoss - slippage
      : position.stopLoss + slippage;
    const reason = position.stopLoss === position.originalStopLoss
      ? "sl"
      : position.trailingActivatedAt
        ? "trail"
        : "break_even";
    return buildExit(position, candle, config, price, reason, ambiguous, slippage);
  }

  return buildExit(position, candle, config, position.takeProfit, "tp", ambiguous);
}

export function closeAtMarket(
  position: OpenBacktestPosition,
  candle: Candle,
  config: ExecutionConfig,
  reason: BacktestExitReason = "end",
): BacktestExit {
  const spread = spreadDistance(config);
  const slippage = slippageDistance(config);
  const price = position.direction === "buy"
    ? candle.close - slippage
    : candle.close + spread + slippage;
  return buildExit(position, candle, config, price, reason, false, slippage);
}

export function ratchetStop(
  position: OpenBacktestPosition,
  executablePrice: number,
  atr: number | null,
  time?: string,
): { position: OpenBacktestPosition; trailingActivated: boolean } {
  const managed = calculateManagedStop({
    direction: position.direction,
    entryPrice: position.entryPrice,
    originalStopLoss: position.originalStopLoss,
    currentStopLoss: position.stopLoss,
    executablePrice,
    atr,
    trailingEnabled: position.trailingEnabled,
    breakEvenDone: position.breakEvenDone,
  });
  let trailingActivatedAt = position.trailingActivatedAt;
  if (managed.trailingActivated) trailingActivatedAt ??= time ?? position.entryTime;

  return {
    position: {
      ...position,
      stopLoss: managed.stopLoss,
      breakEvenDone: managed.breakEvenDone,
      trailingActivatedAt,
    },
    trailingActivated: managed.trailingActivated,
  };
}
