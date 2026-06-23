import { describe, expect, it } from "vitest";
import { mapBrokerSymbolInfo, matchBrokerSymbol } from "../modules/mt5/client.js";

const exness = ["EURUSDm", "GBPUSDm", "USDJPYm", "XAUUSDm", "BTCUSDm", "BTCUSDTm"];

describe("matchBrokerSymbol", () => {
  it("prefers an exact match", () => {
    expect(matchBrokerSymbol("EURUSDm", exness)).toBe("EURUSDm");
    expect(matchBrokerSymbol("EURUSD", ["EURUSD", "EURUSDm"])).toBe("EURUSD");
  });
  it("resolves a bare lowercase broker tag (Exness 'm')", () => {
    expect(matchBrokerSymbol("EURUSD", exness)).toBe("EURUSDm");
    expect(matchBrokerSymbol("XAUUSD", exness)).toBe("XAUUSDm");
  });
  it("resolves separator suffixes", () => {
    expect(matchBrokerSymbol("EURUSD", ["EURUSD.r", "EURUSD-ECN"])).toBe("EURUSD.r");
  });
  it("does NOT confuse BTCUSD with the USDT pair", () => {
    // tag "Tm" has an uppercase letter → not treated as a broker tag
    expect(matchBrokerSymbol("BTCUSD", exness)).toBe("BTCUSDm");
  });
  it("prefers the shortest tag when several match", () => {
    expect(matchBrokerSymbol("EURUSD", ["EURUSDmicro", "EURUSDm"])).toBe("EURUSDm");
  });
  it("returns the original when nothing matches or list is empty", () => {
    expect(matchBrokerSymbol("EURUSD", [])).toBe("EURUSD");
    expect(matchBrokerSymbol("EURUSD", ["GBPUSDm"])).toBe("EURUSD");
  });
  it("is case-insensitive for the exact/core match", () => {
    expect(matchBrokerSymbol("eurusd", ["EURUSDm"])).toBe("EURUSDm");
  });
});

describe("matchBrokerSymbol — cross-broker aliases", () => {
  it("maps XAUUSD to a broker that lists gold as GOLD (with suffix)", () => {
    expect(matchBrokerSymbol("XAUUSD", ["GOLDm", "EURUSDm"])).toBe("GOLDm");
  });
  it("maps the other direction too (GOLD → XAUUSD)", () => {
    expect(matchBrokerSymbol("GOLD", ["XAUUSDm"])).toBe("XAUUSDm");
  });
  it("maps index aliases (NAS100 → USTEC, US30 → DJ30)", () => {
    expect(matchBrokerSymbol("NAS100", ["USTECm"])).toBe("USTECm");
    expect(matchBrokerSymbol("US30", ["DJ30.cash"])).toBe("DJ30.cash");
  });
  it("prefers a direct/suffix match over an alias", () => {
    expect(matchBrokerSymbol("XAUUSD", ["XAUUSDm", "GOLDm"])).toBe("XAUUSDm");
  });
  it("still returns the original when no alias is offered", () => {
    expect(matchBrokerSymbol("XAUUSD", ["EURUSDm"])).toBe("XAUUSD");
  });
});

describe("mapBrokerSymbolInfo", () => {
  it("maps MT5 snake-case metadata to the shared trading spec", () => {
    expect(mapBrokerSymbolInfo({
      symbol: "EURUSDm",
      digits: 5,
      point: 0.00001,
      trade_tick_size: 0.00001,
      trade_tick_value: 1,
      volume_min: 0.01,
      volume_max: 200,
      volume_step: 0.01,
      trade_stops_level: 15,
    })).toEqual({
      symbol: "EURUSDm",
      digits: 5,
      point: 0.00001,
      tickSize: 0.00001,
      tickValue: 1,
      volumeMin: 0.01,
      volumeMax: 200,
      volumeStep: 0.01,
      stopsLevelPoints: 15,
    });
  });
});
