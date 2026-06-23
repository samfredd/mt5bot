import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  lastFindMany: null as Record<string, unknown> | null,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    validationRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `vr${h.rows.length + 1}`, createdAt: new Date(), ...data };
        h.rows.push(row);
        return row;
      }),
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        h.lastFindMany = args;
        return h.rows;
      }),
    },
  },
}));

const { listValidationRuns, recordValidationRun } = await import("../modules/strategy/validation-runs.js");

beforeEach(() => {
  h.rows = [];
  h.lastFindMany = null;
});

describe("validation runs", () => {
  it("persists complete gate evidence and rejection reasons", async () => {
    const row = await recordValidationRun({
      userId: "u1",
      strategyId: "s1",
      candidateName: "London breakout",
      symbol: "EURUSD",
      status: "FAILED",
      trigger: "manual",
      trainStart: "2024-01-01T00:00:00.000Z",
      trainEnd: "2025-07-01T00:00:00.000Z",
      oosStart: "2025-07-01T01:00:00.000Z",
      oosEnd: "2026-01-01T00:00:00.000Z",
      instruments: ["EURUSD", "GBPUSD", "XAUUSD"],
      metrics: { oos: { trades: 18, returnPct: -1.2 } },
      gates: { walkForward: true, sensitivity: true, oos: false, portfolio: false },
      rejectionReasons: ["OOS trades 18 below minimum 20", "OOS return -1.2% is not positive"],
    });

    expect(row).toMatchObject({
      userId: "u1",
      strategyId: "s1",
      candidateName: "London breakout",
      status: "FAILED",
      instruments: ["EURUSD", "GBPUSD", "XAUUSD"],
      rejectionReasons: ["OOS trades 18 below minimum 20", "OOS return -1.2% is not positive"],
    });
  });

  it("lists only the current user's runs and optionally filters by strategy", async () => {
    await listValidationRuns({ userId: "u1", strategyId: "s1", limit: 25 });

    expect(h.lastFindMany).toEqual({
      where: { userId: "u1", strategyId: "s1" },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
  });

  it("can hide infrastructure errors from strategy evidence", async () => {
    h.rows = [
      { id: "vr1", userId: "u1", candidateName: "USDCAD mean reversion", symbol: "USDCAD", status: "ERROR", rejectionReasons: ["validation error: CircuitOpenError: mt5 circuit is open"] },
      { id: "vr2", userId: "u1", candidateName: "USDCAD mean reversion", symbol: "USDCAD", status: "FAILED", rejectionReasons: ["OOS return is not positive"] },
    ];

    const rows = await listValidationRuns({ userId: "u1", limit: 20, includeInfrastructureErrors: false });

    expect(rows).toEqual([h.rows[1]]);
    expect(h.lastFindMany).toMatchObject({ take: 80 });
  });
});
