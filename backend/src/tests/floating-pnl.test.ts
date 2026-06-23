import { describe, expect, it } from "vitest";
import { floatingPnlSnapshot } from "../modules/trading/floating-pnl.js";

describe("floating P&L snapshot", () => {
  it("returns per-position and aggregate floating P&L", () => {
    expect(floatingPnlSnapshot([
      { ticket: "1", symbol: "EURUSD", profit: 12.345 },
      { ticket: "2", symbol: "XAUUSD", profit: -4.2 },
    ], new Date("2026-06-15T10:00:00.000Z"))).toEqual({
      floatingPnl: 8.15,
      positions: [
        { ticket: "1", symbol: "EURUSD", profit: 12.35 },
        { ticket: "2", symbol: "XAUUSD", profit: -4.2 },
      ],
      time: "2026-06-15T10:00:00.000Z",
    });
  });
});
