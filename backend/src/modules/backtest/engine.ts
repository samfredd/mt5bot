import type { Candle } from "../mt5/client.js";
import { analyzeTimeframe, detectSession, type MarketAnalysis } from "../analysis/engine.js";
import { evaluateStrategy, deriveLevels } from "../strategy/service.js";
import { calculateLots } from "../risk/engine.js";
import { valuePerPointPerLot } from "../risk/instruments.js";
import type { Strategy } from "@prisma/client";

/**
 * Event-driven backtester. Honesty-by-construction rules:
 *
 *  - Drives the SAME pure functions as live trading (analyzeTimeframe,
 *    evaluateStrategy, deriveLevels, calculateLots) — no parallel logic.
 *  - Signals are computed on a bar CLOSE and executed at the NEXT bar's
 *    open, plus spread and slippage. No look-ahead.
 *  - Same 200-bar context window the live loop uses.
 *  - If a bar's range covers both SL and TP, the STOP fills first
 *    (conservative assumption).
 *  - The AI layer is not simulated: live, it can only veto trades, so
 *    backtest results are an upper bound on trade count.
 *  - Costs modeled: spread, slippage, commission per lot. Swaps are NOT
 *    modeled — multi-day strategies look slightly better here than reality.
 */

export interface BacktestConfig {
  initialBalance: number;
  spreadPoints: number;       // in points (price units = points * pointSize)
  slippagePoints: number;
  commissionPerLot: number;   // round-trip, account currency
  maxLotSize: number;
}

export interface BacktestTrade {
  openTime: string;
  closeTime: string;
  direction: "buy" | "sell";
  lots: number;
  entry: number;
  exit: number;
  sl: number;
  tp: number;
  profit: number;
  exitReason: "sl" | "tp" | "trail" | "end";
  reasons: string[];
}

export interface BacktestResult {
  symbol: string;
  timeframe: string;
  bars: number;
  from: string;
  to: string;
  config: BacktestConfig;
  trades: BacktestTrade[];
  stats: {
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
    avgWin: number | null;
    avgLoss: number | null;
    sharpe: number | null;
    finalBalance: number;
  };
  equityCurve: { time: string; equity: number }[];
  warnings: string[];
}

const TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
const WINDOW = 200;

/** Aggregate primary-timeframe candles up to a higher timeframe. */
export function aggregateCandles(candles: Candle[], fromMin: number, toMin: number): Candle[] {
  if (toMin <= fromMin || toMin % fromMin !== 0) return candles;
  const bucketMs = toMin * 60_000;
  const out: Candle[] = [];
  let bucket: Candle | null = null;
  let bucketKey = -1;
  for (const c of candles) {
    const t = new Date(c.time).getTime();
    const key = Math.floor(t / bucketMs);
    if (key !== bucketKey) {
      if (bucket) out.push(bucket);
      bucket = { ...c, time: new Date(key * bucketMs).toISOString() };
      bucketKey = key;
    } else if (bucket) {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.tick_volume += c.tick_volume;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

function pointSize(price: number): number {
  return price < 100 ? 0.0001 : 0.01;
}

export function runBacktest(
  strategy: Pick<Strategy, "id" | "name" | "config">,
  symbol: string,
  primaryCandles: Candle[],
  cfg: BacktestConfig,
): BacktestResult {
  const warnings: string[] = [
    "AI veto layer not simulated — live trade count will be lower.",
    "Swap/overnight costs not modeled.",
  ];
  const strategyConfig = strategy.config as { timeframes?: string[]; maxTradesPerDay?: number };
  const timeframes = strategyConfig.timeframes?.length ? strategyConfig.timeframes : ["M15", "H1"];
  const primaryTf = timeframes[0];
  const primaryMin = TF_MINUTES[primaryTf] ?? 60;

  // Pre-aggregate every higher timeframe once.
  const series: Record<string, Candle[]> = { [primaryTf]: primaryCandles };
  for (const tf of timeframes.slice(1)) {
    const min = TF_MINUTES[tf] ?? primaryMin;
    series[tf] = min > primaryMin ? aggregateCandles(primaryCandles, primaryMin, min) : primaryCandles;
    if (min < primaryMin) warnings.push(`Timeframe ${tf} is below primary ${primaryTf}; using primary data.`);
  }
  // Index into higher-TF series advances as primary time passes (no look-ahead).
  const higherIdx: Record<string, number> = {};
  for (const tf of timeframes.slice(1)) higherIdx[tf] = 0;

  let balance = cfg.initialBalance;
  let peak = balance;
  let maxDrawdownPct = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: { time: string; equity: number }[] = [];
  let open: {
    direction: "buy" | "sell"; lots: number; entry: number; sl: number; tp: number;
    originalSl: number; openTime: string; reasons: string[]; beDone: boolean;
  } | null = null;
  let tradesToday = 0;
  let currentDay = "";
  let lossStreak = 0;
  let maxLossStreak = 0;
  const dailyEquity: number[] = [];
  let lastDayMark = "";

  const point = pointSize(primaryCandles[0]?.close ?? 1);
  const spread = cfg.spreadPoints * point;
  const slip = cfg.slippagePoints * point;

  const strategyRow = { ...strategy, userId: "", type: "", enabled: true, createdAt: new Date(), updatedAt: new Date() } as Strategy;

  for (let i = WINDOW; i < primaryCandles.length - 1; i++) {
    const bar = primaryCandles[i];
    const nextBar = primaryCandles[i + 1];
    const barTime = new Date(bar.time);
    const day = bar.time.slice(0, 10);
    if (day !== currentDay) { currentDay = day; tradesToday = 0; }

    // ---- manage open position on the CURRENT bar ----
    if (open) {
      const contract = valuePerPointPerLot(symbol, open.entry);
      const closePosition = (exitPrice: number, reason: BacktestTrade["exitReason"]) => {
        const diff = open!.direction === "buy" ? exitPrice - open!.entry : open!.entry - exitPrice;
        // Round like a broker ledger so trade P/L sums exactly to balance.
        const profit = Number((diff * open!.lots * contract - cfg.commissionPerLot * open!.lots).toFixed(2));
        balance += profit;
        trades.push({
          openTime: open!.openTime, closeTime: bar.time, direction: open!.direction,
          lots: open!.lots, entry: open!.entry, exit: exitPrice, sl: open!.originalSl, tp: open!.tp,
          profit, exitReason: reason, reasons: open!.reasons,
        });
        lossStreak = profit < 0 ? lossStreak + 1 : 0;
        maxLossStreak = Math.max(maxLossStreak, lossStreak);
        open = null;
      };

      const hitSl = open.direction === "buy" ? bar.low <= open.sl : bar.high >= open.sl;
      const hitTp = open.direction === "buy" ? bar.high >= open.tp : bar.low <= open.tp;
      if (hitSl) {
        // Conservative: stop fills first even if TP was also touched.
        closePosition(open.sl, open.sl === open.originalSl ? "sl" : "trail");
      } else if (hitTp) {
        closePosition(open.tp, "tp");
      } else {
        // Break-even at +1R, ATR trail at +1.5R — mirrors the live manager.
        const r = Math.abs(open.entry - open.originalSl);
        const profitDist = open.direction === "buy" ? bar.close - open.entry : open.entry - bar.close;
        if (r > 0) {
          const profitR = profitDist / r;
          if (!open.beDone && profitR >= 1) {
            const be = open.direction === "buy" ? open.entry + 0.1 * r : open.entry - 0.1 * r;
            if (open.direction === "buy" ? be > open.sl : be < open.sl) open.sl = be;
            open.beDone = true;
          }
          if (profitR >= 1.5) {
            const window = primaryCandles.slice(i - WINDOW + 1, i + 1);
            const tfA = analyzeTimeframe(primaryTf, window);
            if (tfA.atr) {
              const trail = open.direction === "buy" ? bar.close - tfA.atr : bar.close + tfA.atr;
              if (open.direction === "buy" ? trail > open.sl : trail < open.sl) open.sl = trail;
            }
          }
        }
      }
    }

    // ---- evaluate for a new signal on bar close ----
    const maxPerDay = strategyConfig.maxTradesPerDay ?? 5;
    if (!open && tradesToday < maxPerDay) {
      const window = primaryCandles.slice(i - WINDOW + 1, i + 1);
      const tfAnalyses = [analyzeTimeframe(primaryTf, window)];
      for (const tf of timeframes.slice(1)) {
        const s = series[tf];
        // advance pointer to the last higher-TF bar that CLOSED before barTime
        const tfMs = (TF_MINUTES[tf] ?? primaryMin) * 60_000;
        while (higherIdx[tf] + 1 < s.length && new Date(s[higherIdx[tf] + 1].time).getTime() + tfMs <= barTime.getTime() + primaryMin * 60_000) {
          higherIdx[tf]++;
        }
        const upto = s.slice(Math.max(0, higherIdx[tf] - WINDOW + 1), higherIdx[tf] + 1);
        if (upto.length >= 60) tfAnalyses.push(analyzeTimeframe(tf, upto));
      }

      const mid = bar.close;
      const analysis: MarketAnalysis = {
        symbol,
        generatedAt: bar.time,
        spreadPoints: cfg.spreadPoints,
        bid: mid - spread / 2,
        ask: mid + spread / 2,
        session: detectSession(barTime),
        timeframes: tfAnalyses,
        summary: "",
      };

      const signal = evaluateStrategy(strategyRow, analysis);
      if (signal.direction) {
        const levels = deriveLevels(signal, analysis);
        if (levels) {
          // Execute at NEXT bar open with spread + slippage.
          const rawOpen = nextBar.open;
          const entry = signal.direction === "buy" ? rawOpen + spread / 2 + slip : rawOpen - spread / 2 - slip;
          const slDist = Math.abs(levels.entry - levels.stopLoss);
          const tpDist = Math.abs(levels.takeProfit - levels.entry);
          const sl = signal.direction === "buy" ? entry - slDist : entry + slDist;
          const tp = signal.direction === "buy" ? entry + tpDist : entry - tpDist;
          const lots = signal.config.lotSizing.method === "fixed"
            ? signal.config.lotSizing.fixedLots
            : calculateLots(symbol, balance, signal.config.lotSizing.riskPct, entry, sl, cfg.maxLotSize);
          if (lots > 0) {
            open = {
              direction: signal.direction, lots, entry, sl, tp, originalSl: sl,
              openTime: nextBar.time, reasons: signal.reasons, beDone: false,
            };
            tradesToday++;
          }
        }
      }
    }

    // ---- equity tracking ----
    let equity = balance;
    if (open) {
      const diff = open.direction === "buy" ? bar.close - open.entry : open.entry - bar.close;
      equity += diff * open.lots * valuePerPointPerLot(symbol, open.entry);
    }
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    equityCurve.push({ time: bar.time, equity: Number(equity.toFixed(2)) });
    if (day !== lastDayMark) { dailyEquity.push(equity); lastDayMark = day; }
  }

  // Close any position left open at the end of data.
  if (open) {
    const last = primaryCandles[primaryCandles.length - 1];
    const o = open as NonNullable<typeof open>;
    const diff = o.direction === "buy" ? last.close - o.entry : o.entry - last.close;
    const profit = Number((diff * o.lots * valuePerPointPerLot(symbol, o.entry) - cfg.commissionPerLot * o.lots).toFixed(2));
    balance += profit;
    trades.push({
      openTime: o.openTime, closeTime: last.time, direction: o.direction, lots: o.lots,
      entry: o.entry, exit: last.close, sl: o.originalSl, tp: o.tp,
      profit, exitReason: "end", reasons: o.reasons,
    });
  }

  // ---- stats ----
  const profits = trades.map((t) => t.profit);
  const wins = profits.filter((p) => p > 0);
  const losses = profits.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const totalPnl = profits.reduce((a, b) => a + b, 0);
  const dailyReturns: number[] = [];
  for (let d = 1; d < dailyEquity.length; d++) {
    if (dailyEquity[d - 1] > 0) dailyReturns.push(dailyEquity[d] / dailyEquity[d - 1] - 1);
  }
  const meanR = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const sdR = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((a, r) => a + (r - meanR) ** 2, 0) / (dailyReturns.length - 1))
    : 0;

  // Downsample equity curve for transport.
  const step = Math.max(1, Math.floor(equityCurve.length / 500));
  const sampledCurve = equityCurve.filter((_, idx) => idx % step === 0);

  return {
    symbol,
    timeframe: primaryTf,
    bars: primaryCandles.length,
    from: primaryCandles[0]?.time ?? "",
    to: primaryCandles[primaryCandles.length - 1]?.time ?? "",
    config: cfg,
    trades,
    stats: {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : null,
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : wins.length ? null : 0,
      expectancy: trades.length ? Number((totalPnl / trades.length).toFixed(2)) : null,
      totalPnl: Number(totalPnl.toFixed(2)),
      returnPct: Number((((balance - cfg.initialBalance) / cfg.initialBalance) * 100).toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      maxLossStreak,
      avgWin: wins.length ? Number((grossProfit / wins.length).toFixed(2)) : null,
      avgLoss: losses.length ? Number((grossLoss / losses.length).toFixed(2)) : null,
      sharpe: sdR > 0 ? Number(((meanR / sdR) * Math.sqrt(252)).toFixed(2)) : null,
      finalBalance: Number(balance.toFixed(2)),
    },
    equityCurve: sampledCurve,
    warnings,
  };
}
