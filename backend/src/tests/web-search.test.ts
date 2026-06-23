import { describe, expect, it } from "vitest";
import { shouldSearch, webSearchConfigured } from "../modules/web/search.js";

describe("web search gating", () => {
  // Pure gate — env-independent so the suite is green whether or not a key is
  // configured locally, and never makes a real network call during tests.
  it("is disabled for an empty/whitespace key", () => {
    expect(shouldSearch("")).toBe(false);
    expect(shouldSearch("   ")).toBe(false);
  });
  it("is enabled when a key is present", () => {
    expect(shouldSearch("tvly-xxx")).toBe(true);
  });
  it("webSearchConfigured returns a boolean reflecting current config", () => {
    expect(typeof webSearchConfigured()).toBe("boolean");
  });
});
