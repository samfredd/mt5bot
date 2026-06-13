import { describe, expect, it } from "vitest";
import { looksLikeSignal, normalizeSymbol, parseSignalRegex } from "../modules/copy/signal-parser.js";

describe("signal parser (regex pass)", () => {
  it("parses a standard channel signal", () => {
    const s = parseSignalRegex("🔥 BUY EURUSD @ 1.0850\nSL: 1.0800\nTP1: 1.0950\nTP2: 1.1020");
    expect(s).toMatchObject({ symbol: "EURUSD", direction: "buy", entry: 1.085, sl: 1.08, tp: 1.095 });
  });

  it("parses gold aliases and short/long wording", () => {
    const s = parseSignalRegex("GOLD short now, stop loss 2380, target 2310");
    expect(s).toMatchObject({ symbol: "XAUUSD", direction: "sell", sl: 2380, tp: 2310 });
  });

  it("picks up explicit lot sizes", () => {
    const s = parseSignalRegex("Sell GBPJPY 0.5 lots sl 193.20 tp 191.00");
    expect(s).toMatchObject({ symbol: "GBPJPY", direction: "sell", lots: 0.5, sl: 193.2, tp: 191 });
  });

  it("handles slash-separated pairs", () => {
    const s = parseSignalRegex("long EUR/USD entry 1.0850 sl 1.0810");
    expect(s).toMatchObject({ symbol: "EURUSD", direction: "buy", sl: 1.081 });
  });

  it("returns null without a direction or symbol", () => {
    expect(parseSignalRegex("good morning traders, market looks choppy")).toBeNull();
    expect(parseSignalRegex("buy the dip!")).toBeNull();
  });

  it("looksLikeSignal pre-filter", () => {
    expect(looksLikeSignal("SELL XAUUSD sl 2380")).toBe(true);
    expect(looksLikeSignal("what a great day")).toBe(false);
    expect(looksLikeSignal("I might buy a car")).toBe(false);
  });

  it("normalizes aliases", () => {
    expect(normalizeSymbol("gold")).toBe("XAUUSD");
    expect(normalizeSymbol("EUR/USD")).toBe("EURUSD");
    expect(normalizeSymbol("nas100")).toBe("NAS100");
  });
});
