import { describe, expect, it } from "vitest";
import { calculateLots } from "../modules/risk/engine.js";
import {
  moneyForPriceMove,
  priceDistanceFromPoints,
  type TradingInstrumentSpec,
} from "../modules/risk/instruments.js";

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

describe("broker units", () => {
  it("converts five-digit EURUSD points to price exactly once", () => {
    expect(priceDistanceFromPoints(1, eurusd)).toBeCloseTo(0.00001, 10);
    expect(priceDistanceFromPoints(10, eurusd)).toBeCloseTo(0.0001, 10);
    expect(priceDistanceFromPoints(15, eurusd)).toBeCloseTo(0.00015, 10);
  });

  it("calculates money from tick size and tick value", () => {
    expect(moneyForPriceMove(0.003, 0.16, eurusd)).toBeCloseTo(48, 8);
  });
});

describe("risk-based lot sizing with broker metadata", () => {
  it("interprets riskPct 0.5 as one half of one percent", () => {
    const lots = calculateLots("EURUSD", 10_000, 0.5, 1.1, 1.097, 1, eurusd);

    expect(lots).toBe(0.16);
    expect(moneyForPriceMove(0.003, lots, eurusd)).toBeCloseTo(48, 8);
  });

  it("floors to the broker volume step instead of rounding risk upward", () => {
    const lots = calculateLots("EURUSD", 10_000, 0.5, 1.1, 1.097, 1, eurusd);

    expect(lots).not.toBe(0.17);
  });

  it("honors broker minimum volume when calculated risk is smaller", () => {
    expect(calculateLots("EURUSD", 100, 0.1, 1.1, 1.097, 1, eurusd)).toBe(0.01);
  });

  it("honors the lower of configured and broker maximum volume", () => {
    const constrained = { ...eurusd, volumeMax: 0.3 };

    expect(calculateLots("EURUSD", 1_000_000, 5, 1.1, 1.099, 1, constrained)).toBe(0.3);
  });
});
