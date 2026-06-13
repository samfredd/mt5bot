import { describe, expect, it } from "vitest";
import { classifyInstrument, valuePerPointPerLot } from "../modules/risk/instruments.js";

describe("classifyInstrument", () => {
  it("recognizes USD-quoted FX majors", () => {
    const s = classifyInstrument("EURUSD");
    expect(s.kind).toBe("fx");
    expect(s.contractSize).toBe(100_000);
    expect(s.quoteCurrency).toBe("USD");
  });
  it("recognizes USD-based pairs", () => {
    expect(classifyInstrument("USDJPY")).toMatchObject({ kind: "fx", baseCurrency: "USD", quoteCurrency: "JPY" });
  });
  it("recognizes gold with its 100oz contract", () => {
    expect(classifyInstrument("XAUUSD")).toMatchObject({ kind: "metal", contractSize: 100, quoteCurrency: "USD" });
  });
  it("recognizes silver's 5000oz contract", () => {
    expect(classifyInstrument("XAGUSD").contractSize).toBe(5000);
  });
  it("recognizes crypto", () => {
    expect(classifyInstrument("BTCUSD")).toMatchObject({ kind: "crypto", contractSize: 1, quoteCurrency: "USD" });
  });
  it("treats indices and unknowns as $1/point USD instruments", () => {
    expect(classifyInstrument("US30")).toMatchObject({ kind: "index", contractSize: 1, quoteCurrency: "USD" });
    expect(classifyInstrument("NAS100").contractSize).toBe(1);
  });
  it("strips separator broker suffixes", () => {
    expect(classifyInstrument("EURUSD.m").quoteCurrency).toBe("USD");
    expect(classifyInstrument("XAUUSD-ECN").contractSize).toBe(100);
  });
  it("handles bare appended broker tags (Exness 'm', 'c', …)", () => {
    expect(classifyInstrument("EURUSDm")).toMatchObject({ kind: "fx", contractSize: 100_000, baseCurrency: "EUR", quoteCurrency: "USD" });
    expect(classifyInstrument("USDJPYm")).toMatchObject({ kind: "fx", baseCurrency: "USD", quoteCurrency: "JPY" });
    expect(classifyInstrument("XAUUSDm")).toMatchObject({ kind: "metal", contractSize: 100, quoteCurrency: "USD" });
    expect(classifyInstrument("BTCUSDm")).toMatchObject({ kind: "crypto", contractSize: 1, quoteCurrency: "USD" });
  });
  it("handles non-USD crosses", () => {
    expect(classifyInstrument("EURGBP")).toMatchObject({ baseCurrency: "EUR", quoteCurrency: "GBP" });
  });
});

describe("valuePerPointPerLot (USD account)", () => {
  it("EURUSD = full contract ($10/pip)", () => {
    expect(valuePerPointPerLot("EURUSD", 1.085)).toBeCloseTo(100_000);
  });
  it("XAUUSD = 100 (a $1 gold move is $100/lot)", () => {
    expect(valuePerPointPerLot("XAUUSD", 2350)).toBeCloseTo(100);
  });
  it("USDJPY converts via 1/price", () => {
    expect(valuePerPointPerLot("USDJPY", 151)).toBeCloseTo(100_000 / 151);
  });
  it("US30 index = $1 per point per lot", () => {
    expect(valuePerPointPerLot("US30", 39000)).toBeCloseTo(1);
  });
  it("BTCUSD = $1 per $1 move per lot", () => {
    expect(valuePerPointPerLot("BTCUSD", 68000)).toBeCloseTo(1);
  });
  it("sizes correctly through a broker suffix (EURUSDm = full contract)", () => {
    expect(valuePerPointPerLot("EURUSDm", 1.157)).toBeCloseTo(100_000);
    expect(valuePerPointPerLot("XAUUSDm", 4218)).toBeCloseTo(100);
  });
  it("uses an approximate static rate for non-USD crosses", () => {
    // GBPJPY: 100k contract, quote JPY ≈ 1/151 USD
    expect(valuePerPointPerLot("GBPJPY", 192.4)).toBeCloseTo(100_000 / 151);
  });
});
