import { describe, expect, it } from "vitest";
import { calculateBacktestStats } from "../modules/backtest/metrics.js";

describe("backtest summary metrics", () => {
  it("derives requested statistics and grouped results from the trade ledger", () => {
    const trades = [
      {
        entryTime: "2026-01-05T08:00:00Z", exitTime: "2026-01-05T09:00:00Z",
        direction: "buy", netPnl: 100, grossPnl: 110, rMultiple: 1,
        exitReason: "tp", sameBarAmbiguous: false, spreadCost: 5, commission: 3, slippageCost: 2,
        session: "london", confidence: 0.82,
      },
      {
        entryTime: "2026-01-06T08:00:00Z", exitTime: "2026-01-06T10:00:00Z",
        direction: "sell", netPnl: -50, grossPnl: -45, rMultiple: -1,
        exitReason: "sl", sameBarAmbiguous: true, spreadCost: 3, commission: 1, slippageCost: 1,
        session: "london", confidence: 0.74,
      },
      {
        entryTime: "2026-02-02T12:00:00Z", exitTime: "2026-02-02T12:30:00Z",
        direction: "sell", netPnl: 200, grossPnl: 210, rMultiple: 2,
        exitReason: "trail", sameBarAmbiguous: false, spreadCost: 5, commission: 3, slippageCost: 2,
        session: "london_newyork_overlap", confidence: 0.91,
      },
      {
        entryTime: "2026-02-03T12:00:00Z", exitTime: "2026-02-03T13:30:00Z",
        direction: "buy", netPnl: -100, grossPnl: -92, rMultiple: -1,
        exitReason: "end", sameBarAmbiguous: false, spreadCost: 4, commission: 2, slippageCost: 2,
        session: "london_newyork_overlap", confidence: 0.65,
      },
    ];
    const curve = [
      { time: "2026-01-05T09:00:00Z", balance: 10_100, equity: 10_100, realizedPnl: 100, unrealizedPnl: 0 },
      { time: "2026-01-06T10:00:00Z", balance: 10_050, equity: 10_050, realizedPnl: 50, unrealizedPnl: 0 },
      { time: "2026-02-02T12:30:00Z", balance: 10_250, equity: 10_250, realizedPnl: 250, unrealizedPnl: 0 },
      { time: "2026-02-03T13:30:00Z", balance: 10_150, equity: 10_150, realizedPnl: 150, unrealizedPnl: 0 },
    ];

    const stats = calculateBacktestStats(trades as never[], 10_000, curve);

    expect(stats.trades).toBe(4);
    expect(stats.grossProfit).toBe(300);
    expect(stats.grossLoss).toBe(150);
    expect(stats.profitFactor).toBe(2);
    expect(stats.averageWinner).toBe(150);
    expect(stats.averageLoser).toBe(75);
    expect(stats.payoffRatio).toBe(2);
    expect(stats.breakEvenWinRate).toBeCloseTo(33.33, 2);
    expect(stats.averageWinningR).toBe(1.5);
    expect(stats.averageLosingR).toBe(-1);
    expect(stats.largestWinner).toBe(200);
    expect(stats.largestLoser).toBe(-100);
    expect(stats.longTradeCount).toBe(2);
    expect(stats.shortTradeCount).toBe(2);
    expect(stats.averageHoldingMinutes).toBe(75);
    expect(stats.medianHoldingMinutes).toBe(75);
    expect(stats.stopLossExitCount).toBe(1);
    expect(stats.takeProfitExitCount).toBe(1);
    expect(stats.trailingStopExitCount).toBe(1);
    expect(stats.endOfTestExitCount).toBe(1);
    expect(stats.sameBarAmbiguousExitCount).toBe(1);
    expect(stats.totalSpreadCost).toBe(17);
    expect(stats.totalCommission).toBe(9);
    expect(stats.totalSlippage).toBe(7);
    expect(stats.monthlyResults).toHaveLength(2);
    expect(stats.sessionResults).toHaveLength(2);
    expect(stats.confidenceBucketResults.length).toBeGreaterThan(1);
    expect(stats.finalBalance).toBe(10_150);
  });
});
