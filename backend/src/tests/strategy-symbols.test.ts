import { describe, expect, it } from "vitest";
import { ALL_FX, ALL_FX_CAP, expandStrategySymbols } from "../modules/strategy/symbols.js";

describe("expandStrategySymbols", () => {
  const broker = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD", "US30", "EURJPY"];

  it("expands ALL_FX to only the FX pairs the broker offers", () => {
    expect(expandStrategySymbols([ALL_FX], broker)).toEqual(["EURUSD", "GBPUSD", "USDJPY", "EURJPY"]);
  });

  it("passes non-sentinel symbols through untouched", () => {
    expect(expandStrategySymbols(["XAUUSD", "US30"], broker)).toEqual(["XAUUSD", "US30"]);
  });

  it("mixes a sentinel with explicit symbols and de-dupes", () => {
    expect(expandStrategySymbols(["EURUSD", ALL_FX], broker)).toEqual(["EURUSD", "GBPUSD", "USDJPY", "EURJPY"]);
  });

  it("handles broker suffixes (e.g. Exness 'm') as FX", () => {
    expect(expandStrategySymbols([ALL_FX], ["EURUSDm", "GBPUSDm", "XAUUSDm"])).toEqual(["EURUSDm", "GBPUSDm"]);
  });

  it("caps the expanded universe to ALL_FX_CAP", () => {
    // All classify as FX (core "EURUSD"); the trailing digits are broker tags.
    const fxList = Array.from({ length: ALL_FX_CAP + 10 }, (_, i) => `EURUSD${i}`);
    expect(expandStrategySymbols([ALL_FX], fxList).length).toBe(ALL_FX_CAP);
  });

  it("returns nothing extra when ALL_FX is given but the broker lists no FX", () => {
    expect(expandStrategySymbols([ALL_FX], ["XAUUSD", "US30", "BTCUSD"])).toEqual([]);
  });
});
