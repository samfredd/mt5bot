import { describe, expect, it } from "vitest";
import { aggregateCandles, runBacktest, runWalkForward, type BacktestConfig } from "../modules/backtest/engine.js";
import { asianRange, detectSession } from "../modules/analysis/engine.js";
import type { Candle } from "../modules/mt5/client.js";

const cfg: BacktestConfig = {
  initialBalance: 10000, spreadPoints: 10, slippagePoints: 1, commissionPerLot: 7, maxLotSize: 1,
};

/** Synthetic H1 series: drifting random-walk with seeded noise. */
function makeCandles(n: number, drift: number, seed = 42): Candle[] {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31 - 0.5; };
  const out: Candle[] = [];
  let price = 1.1;
  const start = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const o = price;
    const move = drift + rand() * 0.002;
    const c = Math.max(o + move, 0.5);
    const h = Math.max(o, c) + Math.abs(rand()) * 0.0008;
    const l = Math.min(o, c) - Math.abs(rand()) * 0.0008;
    price = c;
    out.push({
      time: new Date(start + i * 3600_000).toISOString(),
      open: o, high: h, low: l, close: c, tick_volume: 100,
    });
  }
  return out;
}

const strategy = {
  id: "bt1",
  name: "BT Trend",
  config: {
    symbols: ["EURUSD"],
    timeframes: ["H1", "H4"],
    entry: { requireTrendAlignment: true, rsiOversold: 35, rsiOverbought: 65, useMacdCross: true, useCandlePatterns: false, minConfidence: 0.6 },
    exit: { stopLossAtrMult: 1.5, takeProfitAtrMult: 3.0, trailingStop: true },
    lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 1.0 },
    maxTradesPerDay: 5,
    sessions: ["asia", "london", "newyork", "london_newyork_overlap", "sydney"],
    newsBehavior: "pause",
  },
};

describe("backtest engine", () => {
  it("produces trades on a trending series and accounts costs", () => {
    const r = runBacktest(strategy, "EURUSD", makeCandles(2000, 0.00012), cfg);
    expect(r.stats.trades).toBeGreaterThan(0);
    expect(r.equityCurve.length).toBeGreaterThan(10);
    // Every trade entry happens at or after its signal bar (no look-ahead):
    for (const t of r.trades) {
      expect(new Date(t.closeTime).getTime()).toBeGreaterThanOrEqual(new Date(t.openTime).getTime());
    }
    // P/L reconciles with final balance:
    const sum = r.trades.reduce((a, t) => a + t.profit, 0);
    expect(r.stats.finalBalance).toBeCloseTo(cfg.initialBalance + sum, 1);
    expect(r.equityCurve.at(-1)?.equity).toBe(r.stats.finalBalance);
    for (const t of r.trades) {
      expect(Date.parse(t.signalTime)).toBeLessThan(Date.parse(t.entryTime));
    }
  });

  it("is deterministic for identical input", () => {
    const candles = makeCandles(1500, 0.0001);
    const a = runBacktest(strategy, "EURUSD", candles, cfg);
    const b = runBacktest(strategy, "EURUSD", candles, cfg);
    expect(a.stats).toEqual(b.stats);
    expect(a.trades.length).toBe(b.trades.length);
  });

  it("buy entries pay the spread (entry above bar open)", () => {
    const candles = makeCandles(2000, 0.00012);
    const r = runBacktest(strategy, "EURUSD", candles, cfg);
    const buys = r.trades.filter((t) => t.direction === "buy");
    for (const t of buys) {
      const bar = candles.find((c) => c.time === t.openTime);
      expect(bar).toBeDefined();
      expect(t.entry).toBeGreaterThan(bar!.open); // open + half-spread + slippage
    }
  });

  it("higher costs strictly reduce performance", () => {
    const candles = makeCandles(2500, 0.0001);
    const cheap = runBacktest(strategy, "EURUSD", candles, { ...cfg, spreadPoints: 0, slippagePoints: 0, commissionPerLot: 0 });
    const pricey = runBacktest(strategy, "EURUSD", candles, { ...cfg, spreadPoints: 40, slippagePoints: 10, commissionPerLot: 20 });
    if (cheap.stats.trades > 0 && pricey.stats.trades > 0) {
      expect(pricey.stats.totalPnl).toBeLessThan(cheap.stats.totalPnl);
    }
  });

  it("aggregates H1 to H4 correctly", () => {
    const candles = makeCandles(40, 0.0001);
    const h4 = aggregateCandles(candles, 60, 240);
    expect(h4.length).toBe(10);
    expect(h4[0].open).toBe(candles[0].open);
    expect(h4[0].close).toBe(candles[3].close);
    expect(h4[0].high).toBe(Math.max(...candles.slice(0, 4).map((c) => c.high)));
    expect(h4[0].low).toBe(Math.min(...candles.slice(0, 4).map((c) => c.low)));
  });

  it("reports honest warnings", () => {
    const r = runBacktest(strategy, "EURUSD", makeCandles(1200, 0.0001), cfg);
    expect(r.warnings.join(" ")).toMatch(/AI veto/);
    expect(r.warnings.join(" ")).toMatch(/Swap/);
  });
});

describe("asianRange (breakout reference level)", () => {
  // Hourly candles across one UTC day: 00:00–06:00 are the Asian session.
  const day = Date.UTC(2025, 5, 2); // a Monday
  const hourly: Candle[] = Array.from({ length: 14 }, (_, h) => ({
    time: new Date(day + h * 3600_000).toISOString(),
    open: 1.1, high: 1.1 + (h < 7 ? 0.002 : 0.02), low: 1.1 - (h < 7 ? 0.002 : 0.02),
    close: 1.1, tick_volume: 100,
  }));

  it("returns null before the Asian session has closed", () => {
    expect(asianRange(hourly, day + 3 * 3600_000)).toBeNull(); // 03:00, still in Asia
  });
  it("returns the Asian high/low once London has opened", () => {
    const r = asianRange(hourly, day + 9 * 3600_000); // 09:00 London
    expect(r).not.toBeNull();
    expect(r!.high).toBeCloseTo(1.102); // tight Asian range, not the wide London bars
    expect(r!.low).toBeCloseTo(1.098);
  });
});

describe("DST-aware trading sessions", () => {
  it("does not start the winter London/New York overlap an hour early", () => {
    expect(detectSession(new Date("2026-01-15T12:30:00Z"))).toBe("london");
    expect(detectSession(new Date("2026-01-15T13:30:00Z"))).toBe("london_newyork_overlap");
  });

  it("moves the overlap with daylight-saving time", () => {
    expect(detectSession(new Date("2026-07-15T11:30:00Z"))).toBe("london");
    expect(detectSession(new Date("2026-07-15T12:30:00Z"))).toBe("london_newyork_overlap");
  });
});

describe("walk-forward", () => {
  it("splits into the requested number of windows and aggregates consistency", () => {
    const candles = makeCandles(4000, 0.00012);
    const full = runBacktest(strategy, "EURUSD", candles, cfg);
    const r = runWalkForward(strategy, "EURUSD", candles, cfg, 4);
    expect(r.folds.length).toBeGreaterThan(0);
    expect(r.folds.length).toBeLessThanOrEqual(4);
    // Folds are consecutive and non-overlapping in time.
    for (let i = 1; i < r.folds.length; i++) {
      expect(new Date(r.folds[i].from).getTime()).toBeGreaterThanOrEqual(new Date(r.folds[i - 1].to).getTime());
    }
    expect(r.consistency.foldCount).toBe(r.folds.length);
    expect(r.consistency.profitableFolds).toBe(r.folds.filter((f) => f.returnPct > 0).length);
    expect(r.consistency.verdict).toBeTruthy();
    expect(Math.abs(r.consistency.totalTrades - full.stats.trades)).toBeLessThanOrEqual(4);
  });

  it("is deterministic", () => {
    const candles = makeCandles(3000, 0.0001);
    const a = runWalkForward(strategy, "EURUSD", candles, cfg, 3);
    const b = runWalkForward(strategy, "EURUSD", candles, cfg, 3);
    expect(a.consistency).toEqual(b.consistency);
  });

  it("flags too-few-trades as noise rather than edge", () => {
    // A tiny series yields almost no trades → must not claim an edge.
    const r = runWalkForward(strategy, "EURUSD", makeCandles(900, 0.0001), cfg, 3);
    if (r.consistency.totalTrades < r.consistency.foldCount * 5) {
      expect(r.consistency.verdict).toMatch(/noise|Not enough/i);
    }
  });
});
