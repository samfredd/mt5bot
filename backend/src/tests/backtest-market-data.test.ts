import { describe, expect, it } from "vitest";
import {
  aggregateCandles,
  candlesVisibleAt,
  isNewCompletedBar,
  normalizeCandles,
} from "../modules/backtest/market-data.js";
import type { Candle } from "../modules/mt5/client.js";

function candle(time: string, close = 1.1): Candle {
  return {
    time,
    open: close,
    high: close + 0.001,
    low: close - 0.001,
    close,
    tick_volume: 100,
  };
}

describe("backtest market data", () => {
  it("sorts candles chronologically and keeps the last duplicate", () => {
    const older = candle("2026-01-01T08:00:00Z", 1.08);
    const duplicate = candle("2026-01-01T09:00:00Z", 1.09);
    const replacement = candle("2026-01-01T09:00:00Z", 1.091);

    const out = normalizeCandles([duplicate, older, replacement], "H1");

    expect(out.map((c) => c.time)).toEqual([
      "2026-01-01T08:00:00.000Z",
      "2026-01-01T09:00:00.000Z",
    ]);
    expect(out[1].close).toBe(1.091);
  });

  it("excludes a candle that has not closed at the evaluation time", () => {
    const candles = [
      candle("2026-01-01T08:00:00Z"),
      candle("2026-01-01T09:00:00Z"),
      candle("2026-01-01T10:00:00Z"),
    ];

    const out = normalizeCandles(candles, "H1", Date.parse("2026-01-01T10:30:00Z"));

    expect(out.map((c) => c.time)).toEqual([
      "2026-01-01T08:00:00.000Z",
      "2026-01-01T09:00:00.000Z",
    ]);
  });

  it("uses only the last fully completed H4 candle", () => {
    const h4 = [
      candle("2026-01-01T00:00:00Z", 1.1),
      candle("2026-01-01T04:00:00Z", 1.2),
      candle("2026-01-01T08:00:00Z", 1.3),
    ];

    const visible = candlesVisibleAt(h4, "H4", Date.parse("2026-01-01T05:00:00Z"));

    expect(visible).toHaveLength(1);
    expect(visible[0].time).toBe("2026-01-01T00:00:00.000Z");
  });

  it("aligns aggregate boundaries to the broker offset", () => {
    const h1 = Array.from({ length: 8 }, (_, i) =>
      candle(new Date(Date.UTC(2026, 0, 1, i + 1)).toISOString(), 1 + i / 100),
    );

    const h4 = aggregateCandles(h1, 60, 240, 60);

    expect(h4).toHaveLength(2);
    expect(h4[0].time).toBe("2026-01-01T01:00:00.000Z");
    expect(h4[0].open).toBe(h1[0].open);
    expect(h4[0].close).toBe(h1[3].close);
    expect(h4[1].time).toBe("2026-01-01T05:00:00.000Z");
  });

  it("does not invent candles across weekend or missing-data gaps", () => {
    const candles = [
      candle("2026-01-02T21:00:00Z"),
      candle("2026-01-05T00:00:00Z"),
    ];

    expect(normalizeCandles(candles, "H1")).toHaveLength(2);
  });

  it("identifies whether a completed strategy bar has already been processed", () => {
    expect(isNewCompletedBar("2026-01-01T09:00:00Z", null)).toBe(true);
    expect(isNewCompletedBar("2026-01-01T09:00:00Z", "2026-01-01T09:00:00Z")).toBe(false);
    expect(isNewCompletedBar("2026-01-01T10:00:00Z", "2026-01-01T09:00:00Z")).toBe(true);
  });
});
