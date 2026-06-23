import { describe, expect, it } from "vitest";
import { buildLiveTradingRequestBody } from "./live-settings";

describe("buildLiveTradingRequestBody", () => {
  it("sends a trimmed TOTP token when enabling live trading", () => {
    expect(buildLiveTradingRequestBody(true, " 123456 ")).toEqual({ token: "123456" });
  });

  it("sends an empty body when disabling live trading", () => {
    expect(buildLiveTradingRequestBody(false, "123456")).toEqual({});
  });
});
