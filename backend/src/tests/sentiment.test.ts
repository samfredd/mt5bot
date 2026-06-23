import { describe, expect, it } from "vitest";
import { normalizeSentiment } from "../modules/sentiment/service.js";

describe("structured sentiment", () => {
  it("normalizes score, label, provenance, and age", () => {
    const result = normalizeSentiment({ score: 2, confidence: 1.5, summary: "Strong demand" }, [
      { title: "EUR rises", url: "https://example.com/a", snippet: "" },
    ], new Date("2026-06-15T10:00:00.000Z"), new Date("2026-06-15T10:07:30.000Z"));

    expect(result).toEqual({
      score: 1,
      label: "bullish",
      confidence: 1,
      summary: "Strong demand",
      generatedAt: "2026-06-15T10:00:00.000Z",
      ageSeconds: 450,
      sources: [{ title: "EUR rises", url: "https://example.com/a" }],
    });
  });

  it("derives neutral and bearish labels from the normalized score", () => {
    expect(normalizeSentiment({ score: -0.4, confidence: 0.6, summary: "Risk off" }, [], new Date(), new Date()).label).toBe("bearish");
    expect(normalizeSentiment({ score: 0.1, confidence: 0.6, summary: "Mixed" }, [], new Date(), new Date()).label).toBe("neutral");
  });
});
