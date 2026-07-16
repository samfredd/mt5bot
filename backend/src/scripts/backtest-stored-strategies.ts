import { prisma } from "../lib/prisma.js";
import { mt5 } from "../modules/mt5/client.js";
import { runBacktest, runWalkForward } from "../modules/backtest/engine.js";
import { fallbackTradingSpec } from "../modules/risk/instruments.js";

const TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
const SPREAD_POINTS: Record<string, number> = { EURUSD: 10, GBPUSD: 12, USDJPY: 12, GBPJPY: 27, XAUUSD: 25 };
const days = Number(process.argv[2] ?? 365);
const nameFilter = process.argv[3];
const maxPrimaryBars = Number(process.argv[4] ?? 50_000);

async function main() {
  const strategies = await prisma.strategy.findMany({
    where: nameFilter ? { name: nameFilter } : undefined,
    orderBy: { createdAt: "asc" },
  });
  const results = [];
  for (const strategy of strategies) {
    const cfg = strategy.config as { symbols?: string[]; timeframes?: string[] };
    const symbol = cfg.symbols?.find((value) => value !== "ALL_FX") ?? "EURUSD";
    const timeframes = cfg.timeframes?.length ? cfg.timeframes : ["H1"];
    const primary = timeframes[0];
    const tick = await mt5.tick(symbol);
    const timeframeCandles = Object.fromEntries(await Promise.all(timeframes.map(async (timeframe) => {
      const minutes = TF_MINUTES[timeframe] ?? 60;
      const count = Math.min(Math.ceil((days * 1440 * (5 / 7)) / minutes) + 250, 50_000);
      return [timeframe, await mt5.candles(symbol, timeframe, count)] as const;
    })));
    const candles = (timeframeCandles[primary] ?? []).slice(-maxPrimaryBars);
    timeframeCandles[primary] = candles;
    const instrument = await mt5.symbolInfo(symbol).catch(() => fallbackTradingSpec(symbol, tick.bid));
    const execution = {
      initialBalance: 10_000,
      spreadPoints: SPREAD_POINTS[symbol] ?? 15,
      slippagePoints: 2,
      commissionPerLot: 0,
      maxLotSize: 1,
      sameBarPolicy: "stop_first" as const,
      instrument,
    };
    const options = { timeframeCandles, asOfMs: Date.parse(tick.time) };
    const backtest = runBacktest(strategy, symbol, candles, execution, options);
    // Keep the repeated walk-forward pass bounded on very high-resolution
    // strategies. The full backtest still uses every fetched bar.
    const walkForwardCandles = candles.slice(-20_000);
    const walkForwardStart = Date.parse(walkForwardCandles[0]?.time ?? "");
    const walkForwardSeries = Object.fromEntries(Object.entries(timeframeCandles).map(([timeframe, series]) => [
      timeframe,
      series.filter((candle) => Date.parse(candle.time) >= walkForwardStart),
    ]));
    const walkForward = runWalkForward(strategy, symbol, walkForwardCandles, execution, 4, {
      timeframeCandles: walkForwardSeries,
      asOfMs: Date.parse(tick.time),
    });
    const row = {
      name: strategy.name, symbol, timeframe: primary, bars: backtest.bars,
      trades: backtest.stats.trades, returnPct: backtest.stats.returnPct,
      profitFactor: backtest.stats.profitFactor, maxDrawdownPct: backtest.stats.maxDrawdownPct,
      profitableFolds: walkForward.consistency.profitableFolds,
      folds: walkForward.folds.length,
      meanFoldReturnPct: walkForward.consistency.meanReturnPct,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  console.table(results);
}

main().finally(() => prisma.$disconnect());
