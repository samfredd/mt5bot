import { describe, expect, it } from "vitest";
import {
  closeAtMarket,
  enterPosition,
  ratchetStop,
  resolveBar,
  type ExecutionConfig,
} from "../modules/backtest/execution.js";
import type { Candle } from "../modules/mt5/client.js";
import type { TradingInstrumentSpec } from "../modules/risk/instruments.js";

const eurusd: TradingInstrumentSpec = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  tickValue: 1,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsLevelPoints: 0,
};

const zeroCosts: ExecutionConfig = {
  instrument: eurusd,
  spreadPoints: 0,
  slippagePoints: 0,
  commissionPerLot: 0,
  sameBarPolicy: "stop_first",
};

function bar(time: string, open: number, high: number, low: number, close = open): Candle {
  return { time, open, high, low, close, tick_volume: 100 };
}

function position(direction: "buy" | "sell", config: ExecutionConfig = zeroCosts) {
  return enterPosition({
    symbol: "EURUSD",
    timeframe: "H1",
    signalTime: "2026-01-01T08:00:00Z",
    entryBar: bar("2026-01-01T09:00:00Z", 1.1, 1.1, 1.1),
    direction,
    atr: 0.002,
    stopLossAtrMult: 1.5,
    takeProfitAtrMult: 2.4,
    lots: 1,
    trailingEnabled: true,
    balanceBefore: 10_000,
    config,
  });
}

describe("deterministic stop and target execution", () => {
  it("BUY take-profit returns +1.6R", () => {
    const open = position("buy");
    const exit = resolveBar(open, bar("2026-01-01T10:00:00Z", 1.101, 1.105, 1.1005), zeroCosts);

    expect(open.entryPrice).toBeCloseTo(1.1, 8);
    expect(open.stopLoss).toBeCloseTo(1.097, 8);
    expect(open.takeProfit).toBeCloseTo(1.1048, 8);
    expect(exit?.exitReason).toBe("tp");
    expect(exit?.grossRMultiple).toBeCloseTo(1.6, 8);
  });

  it("BUY stop-loss returns -1R", () => {
    const open = position("buy");
    const exit = resolveBar(open, bar("2026-01-01T10:00:00Z", 1.099, 1.1005, 1.0965), zeroCosts);

    expect(exit?.exitReason).toBe("sl");
    expect(exit?.grossRMultiple).toBeCloseTo(-1, 8);
  });

  it("SELL take-profit returns +1.6R", () => {
    const open = position("sell");
    const exit = resolveBar(open, bar("2026-01-01T10:00:00Z", 1.099, 1.0995, 1.095), zeroCosts);

    expect(open.stopLoss).toBeCloseTo(1.103, 8);
    expect(open.takeProfit).toBeCloseTo(1.0952, 8);
    expect(exit?.exitReason).toBe("tp");
    expect(exit?.grossRMultiple).toBeCloseTo(1.6, 8);
  });

  it("SELL stop-loss returns -1R", () => {
    const open = position("sell");
    const exit = resolveBar(open, bar("2026-01-01T10:00:00Z", 1.101, 1.1035, 1.1005), zeroCosts);

    expect(exit?.exitReason).toBe("sl");
    expect(exit?.grossRMultiple).toBeCloseTo(-1, 8);
  });

  it("respects the broker minimum stop distance", () => {
    const config = {
      ...zeroCosts,
      instrument: { ...eurusd, stopsLevelPoints: 400 },
    };
    const open = position("buy", config);

    expect(open.entryPrice - open.stopLoss).toBeCloseTo(0.004, 8);
  });
});

describe("cost conventions", () => {
  const spreadOnly = { ...zeroCosts, spreadPoints: 15 };

  it("charges BUY spread once by entering at ask and closing at bid", () => {
    const open = position("buy", spreadOnly);
    const exit = closeAtMarket(open, bar("2026-01-01T10:00:00Z", 1.1, 1.1, 1.1, 1.1), spreadOnly, "end");

    expect(open.bidAtEntry).toBeCloseTo(1.1, 8);
    expect(open.askAtEntry).toBeCloseTo(1.10015, 8);
    expect(open.entryPrice).toBeCloseTo(1.10015, 8);
    expect(exit.grossPnl).toBeCloseTo(-15, 8);
    expect(exit.spreadCost).toBeCloseTo(15, 8);
  });

  it("charges SELL spread once by entering at bid and closing at ask", () => {
    const open = position("sell", spreadOnly);
    const exit = closeAtMarket(open, bar("2026-01-01T10:00:00Z", 1.1, 1.1, 1.1, 1.1), spreadOnly, "end");

    expect(open.entryPrice).toBeCloseTo(1.1, 8);
    expect(exit.askAtExit).toBeCloseTo(1.10015, 8);
    expect(exit.grossPnl).toBeCloseTo(-15, 8);
    expect(exit.spreadCost).toBeCloseTo(15, 8);
  });

  it("applies entry slippage adversely for both directions", () => {
    const config = { ...zeroCosts, slippagePoints: 2 };
    const buy = position("buy", config);
    const sell = position("sell", config);

    expect(buy.entryPrice).toBeCloseTo(1.10002, 8);
    expect(sell.entryPrice).toBeCloseTo(1.09998, 8);
  });

  it("charges round-turn commission once at close", () => {
    const config = { ...zeroCosts, commissionPerLot: 7 };
    const open = position("buy", config);
    const exit = closeAtMarket(open, bar("2026-01-01T10:00:00Z", 1.1, 1.1, 1.1, 1.1), config, "end");

    expect(exit.grossPnl).toBeCloseTo(0, 8);
    expect(exit.commission).toBe(7);
    expect(exit.netPnl).toBe(-7);
  });
});

describe("same-bar ambiguity", () => {
  const collision = bar("2026-01-01T10:00:00Z", 1.1, 1.105, 1.096, 1.1);

  it("marks and resolves a collision stop-first by default", () => {
    const exit = resolveBar(position("buy"), collision, zeroCosts);

    expect(exit?.sameBarAmbiguous).toBe(true);
    expect(exit?.exitReason).toBe("sl");
  });

  it("can resolve the same collision target-first for comparison", () => {
    const config = { ...zeroCosts, sameBarPolicy: "tp_first" as const };
    const exit = resolveBar(position("buy", config), collision, config);

    expect(exit?.sameBarAmbiguous).toBe(true);
    expect(exit?.exitReason).toBe("tp");
  });
});

describe("trailing-stop ratchet", () => {
  it("labels a break-even stop separately from an ATR trailing stop", () => {
    const open = position("buy");
    const breakEven = ratchetStop(open, 1.1031, 0.002).position;
    const exit = resolveBar(breakEven, bar("2026-01-01T11:00:00Z", 1.101, 1.1015, 1.1002), zeroCosts);

    expect(breakEven.trailingActivatedAt).toBeNull();
    expect(exit?.exitReason).toBe("break_even");
  });

  it("moves a BUY stop upward and never backward", () => {
    const open = position("buy");
    const first = ratchetStop(open, 1.1046, 0.002);
    const second = ratchetStop(first.position, 1.103, 0.002);

    expect(first.position.stopLoss).toBeGreaterThan(open.stopLoss);
    expect(second.position.stopLoss).toBe(first.position.stopLoss);
  });

  it("moves a SELL stop downward and never backward", () => {
    const open = position("sell");
    const first = ratchetStop(open, 1.0954, 0.002);
    const second = ratchetStop(first.position, 1.097, 0.002);

    expect(first.position.stopLoss).toBeLessThan(open.stopLoss);
    expect(second.position.stopLoss).toBe(first.position.stopLoss);
  });

  it("does not apply the ATR trail when trailing is disabled", () => {
    const open = enterPosition({
      symbol: "EURUSD",
      timeframe: "H1",
      signalTime: "2026-01-01T08:00:00Z",
      entryBar: bar("2026-01-01T09:00:00Z", 1.1, 1.1, 1.1),
      direction: "buy",
      atr: 0.002,
      stopLossAtrMult: 1.5,
      takeProfitAtrMult: 2.4,
      lots: 1,
      trailingEnabled: false,
      balanceBefore: 10_000,
      config: zeroCosts,
    });
    const result = ratchetStop(open, 1.106, 0.002);

    expect(result.position.stopLoss).toBeCloseTo(1.1003, 8);
    expect(result.trailingActivated).toBe(false);
  });
});
