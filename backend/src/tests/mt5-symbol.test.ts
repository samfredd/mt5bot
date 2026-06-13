import { describe, expect, it } from "vitest";
import { matchBrokerSymbol } from "../modules/mt5/client.js";

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
