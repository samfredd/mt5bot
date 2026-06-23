import { describe, expect, it, vi } from "vitest";
import { marketKey, conflictingTrade } from "../modules/trading/symbol-lock.js";

/**
 * Fixture trades the mocked prisma filters over, mirroring the real query:
 *   where: { userId, status: { in }, ...({ OR: [{accountId: null}, {accountId}] } | {}) }
 * so symbolHeldByOther's account scoping is exercised end-to-end.
 */
type Row = { id: string; userId: string; symbol: string; strategyId: string | null; direction: string; accountId: string | null; status: string };
const rows: Row[] = [];

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    trade: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const accountOk = (r: Row) =>
          !where.OR ? true : where.OR.some((clause: { accountId: string | null }) => clause.accountId === r.accountId);
        return rows.filter(
          (r) => r.userId === where.userId && where.status.in.includes(r.status) && accountOk(r),
        );
      }),
    },
  },
}));

const { symbolHeldByOther } = await import("../modules/trading/symbol-lock.js");

describe("marketKey", () => {
  it("collapses broker suffixes/separators to a stable FX core", () => {
    expect(marketKey("EURUSD")).toBe("EURUSD");
    expect(marketKey("EURUSDm")).toBe("EURUSD");
    expect(marketKey("EURUSD.r")).toBe("EURUSD");
    expect(marketKey("gbpjpy")).toBe("GBPJPY");
    expect(marketKey("XAUUSDm")).toBe("XAUUSD");
  });

  it("keeps non-6-letter symbols (indices) distinct", () => {
    expect(marketKey("US30")).toBe("US30");
    expect(marketKey("NAS100")).toBe("NAS100");
    expect(marketKey("US30")).not.toBe(marketKey("NAS100"));
  });
});

describe("conflictingTrade", () => {
  const t = (symbol: string, strategyId: string | null, id = symbol) => ({ id, symbol, strategyId });

  it("flags a same-pair trade owned by another strategy", () => {
    const live = [t("EURUSDm", "strat-A")];
    expect(conflictingTrade(live, "EURUSD", "strat-B")?.id).toBe("EURUSDm");
  });

  it("flags a manual/scanner trade (no strategyId) on the pair", () => {
    const live = [t("EURUSDm", null)];
    expect(conflictingTrade(live, "EURUSDm", "strat-B")).not.toBeNull();
  });

  it("does NOT flag the pair when only this strategy holds it", () => {
    const live = [t("EURUSDm", "strat-B")];
    expect(conflictingTrade(live, "EURUSD", "strat-B")).toBeNull();
  });

  it("ignores positions on other pairs", () => {
    const live = [t("GBPJPYm", "strat-A"), t("US30", null)];
    expect(conflictingTrade(live, "EURUSD", "strat-B")).toBeNull();
  });

  it("matches across suffix mismatches (raw vs broker symbol)", () => {
    const live = [t("EURUSD", "strat-A")]; // stored raw
    expect(conflictingTrade(live, "EURUSDm", "strat-B")?.id).toBe("EURUSD");
  });
});

describe("symbolHeldByOther — account scoping", () => {
  const row = (over: Partial<Row>): Row => ({
    id: "x", userId: "u1", symbol: "EURUSD", strategyId: "strat-A", direction: "BUY",
    accountId: "acctA", status: "EXECUTED", ...over,
  });
  const reset = (...r: Row[]) => { rows.length = 0; rows.push(...r); };

  it("does NOT block when the only occupying trade is on a DIFFERENT account", async () => {
    // The live regression: a zombie EURUSD trade on the old account 'acctA' must
    // not block strategy-B now that the terminal is on 'acctB'.
    reset(row({ accountId: "acctA", strategyId: null }));
    expect(await symbolHeldByOther("u1", "EURUSD", "strat-B", "acctB")).toBeNull();
  });

  it("blocks when the occupying trade is on the CURRENT account", async () => {
    reset(row({ accountId: "acctB", strategyId: "strat-A" }));
    const held = await symbolHeldByOther("u1", "EURUSD", "strat-B", "acctB");
    expect(held?.id).toBe("x");
  });

  it("blocks on legacy unstamped (accountId null) trades regardless of account", async () => {
    reset(row({ accountId: null, strategyId: null }));
    expect(await symbolHeldByOther("u1", "EURUSD", "strat-B", "acctB")).not.toBeNull();
  });

  it("falls back to unscoped when the account is unknown (bridge down)", async () => {
    reset(row({ accountId: "acctA", strategyId: "strat-A" }));
    expect(await symbolHeldByOther("u1", "EURUSD", "strat-B", null)).not.toBeNull();
  });
});
