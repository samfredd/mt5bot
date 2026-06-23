import { describe, expect, it } from "vitest";
import { positionsForNewsFlatten } from "../modules/news/flatten.js";

const now = new Date("2026-06-15T10:00:00.000Z");
const positions = [
  { ticket: "eur", symbol: "EURUSD" },
  { ticket: "gold", symbol: "XAUUSD" },
];

describe("high-impact news flattening", () => {
  it("defaults to no flattening when disabled", () => {
    expect(positionsForNewsFlatten({
      enabled: false,
      leadMinutes: 15,
      minimumImpact: "HIGH",
      symbols: ["EURUSD"],
      events: [{ currency: "EUR", impact: "HIGH", eventTime: new Date("2026-06-15T10:10:00.000Z") }],
      positions,
      now,
    })).toEqual([]);
  });

  it("selects only scoped positions with qualifying impact inside the lead window", () => {
    expect(positionsForNewsFlatten({
      enabled: true,
      leadMinutes: 15,
      minimumImpact: "HIGH",
      symbols: ["EURUSD"],
      events: [
        { currency: "EUR", impact: "HIGH", eventTime: new Date("2026-06-15T10:10:00.000Z") },
        { currency: "USD", impact: "MEDIUM", eventTime: new Date("2026-06-15T10:05:00.000Z") },
      ],
      positions,
      now,
    })).toEqual([{ ticket: "eur", symbol: "EURUSD" }]);
  });

  it("ignores qualifying events outside the lead window", () => {
    expect(positionsForNewsFlatten({
      enabled: true,
      leadMinutes: 15,
      minimumImpact: "HIGH",
      symbols: ["EURUSD"],
      events: [{ currency: "EUR", impact: "HIGH", eventTime: new Date("2026-06-15T10:20:00.000Z") }],
      positions,
      now,
    })).toEqual([]);
  });
});
