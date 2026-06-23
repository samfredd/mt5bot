import { describe, expect, it } from "vitest";
import { adx, atr, bollinger, ema, macd, rsi, sma } from "../modules/analysis/indicators.js";
import { AiDecisionSchema, AI_SAFE_FALLBACK } from "../modules/ai/schema.js";

describe("indicators", () => {
  it("sma averages correctly", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([2, 3, 4]);
  });

  it("ema converges toward recent values", () => {
    const out = ema([1, 1, 1, 1, 1, 10, 10, 10, 10, 10], 3);
    expect(out[out.length - 1]).toBeGreaterThan(9);
  });

  it("rsi is 100 for monotonic gains and low for losses", () => {
    const up = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
    expect(up[up.length - 1]).toBe(100);
    const down = rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14);
    expect(down[down.length - 1]).toBeLessThan(5);
  });

  it("macd produces aligned series", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 3);
    const { macdLine, signalLine, histogram } = macd(closes);
    expect(signalLine.length).toBe(histogram.length);
    expect(macdLine.length).toBeGreaterThan(signalLine.length);
  });

  it("bollinger bands bracket the mean", () => {
    const closes = Array.from({ length: 50 }, () => 100 + (Math.random() - 0.5));
    const { upper, mid, lower } = bollinger(closes, 20, 2);
    const i = upper.length - 1;
    expect(upper[i]).toBeGreaterThan(mid[i]);
    expect(lower[i]).toBeLessThan(mid[i]);
  });

  it("atr is positive for moving prices", () => {
    const highs = Array.from({ length: 40 }, (_, i) => 101 + i * 0.1);
    const lows = highs.map((h) => h - 1);
    const closes = highs.map((h) => h - 0.5);
    const out = atr(highs, lows, closes, 14);
    expect(out[out.length - 1]).toBeGreaterThan(0);
  });

  it("adx reads high in a strong trend and low in chop", () => {
    // Strong, steady uptrend → high ADX.
    const n = 80;
    const upH = Array.from({ length: n }, (_, i) => 100 + i);
    const upL = upH.map((h) => h - 0.5);
    const upC = upH.map((h) => h - 0.2);
    const trendAdx = adx(upH, upL, upC, 14);
    expect(trendAdx[trendAdx.length - 1]).toBeGreaterThan(40);

    // Flat oscillation around a level → low ADX (no directional move).
    const chopC = Array.from({ length: n }, (_, i) => 100 + (i % 2 === 0 ? 0.3 : -0.3));
    const chopH = chopC.map((c) => c + 0.4);
    const chopL = chopC.map((c) => c - 0.4);
    const chopAdx = adx(chopH, chopL, chopC, 14);
    expect(chopAdx[chopAdx.length - 1]).toBeLessThan(25);
  });
});

describe("AI output validation", () => {
  it("accepts a well-formed decision", () => {
    const parsed = AiDecisionSchema.safeParse({
      decision: "buy", confidence: 0.8, reasoning: "trend continuation", risk_level: "low",
      suggested_entry: 1.085, suggested_stop_loss: 1.0825, suggested_take_profit: 1.09,
      news_risk: "low", should_execute: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects malformed output (the safe fallback applies)", () => {
    expect(AiDecisionSchema.safeParse({ decision: "yolo", confidence: 2 }).success).toBe(false);
    expect(AI_SAFE_FALLBACK.decision).toBe("avoid");
    expect(AI_SAFE_FALLBACK.should_execute).toBe(false);
  });
});
