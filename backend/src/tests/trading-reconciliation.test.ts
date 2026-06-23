import { beforeEach, describe, expect, it, vi } from "vitest";

type Trade = {
  id: string;
  userId: string;
  symbol: string;
  mt5Ticket: string;
  direction?: "BUY" | "SELL";
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
};

const h = vi.hoisted(() => ({
  account: { login: "100" } as { login: string } | null,
  open: [] as Trade[],
  backfill: [] as Trade[],
  positions: [] as { ticket: string }[],
  deals: [] as { ticket?: string; position_id?: string; profit?: number; price?: number; time?: string }[],
  historyRejects: false,
  updates: [] as { id: string; data: Record<string, unknown> }[],
  findManyCalls: [] as Record<string, unknown>[],
  notifications: [] as { userId: string; title: string; message: string }[],
  broadcasts: [] as { event: string; payload: unknown }[],
  errors: [] as { source: string; message: string; detail: unknown }[],
  incidents: [] as { dedupeKey: string; severity: string }[],
  comparisons: [] as Record<string, unknown>[],
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    trade: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        h.findManyCalls.push(where);
        return where.status === "EXECUTED" ? h.open : h.backfill;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        h.updates.push({ id: where.id, data });
        return { id: where.id, ...data };
      }),
    },
  },
}));

vi.mock("../lib/audit.js", () => ({
  logError: vi.fn(async (source: string, message: string, detail: unknown) => {
    h.errors.push({ source, message, detail });
  }),
}));

vi.mock("../modules/mt5/client.js", () => ({
  mt5: {
    accountInfo: vi.fn(async () => {
      if (!h.account) throw new Error("bridge unavailable");
      return h.account;
    }),
    positions: vi.fn(async () => h.positions),
    history: vi.fn(async () => {
      if (h.historyRejects) throw new Error("history unavailable");
      return h.deals;
    }),
  },
}));

vi.mock("../modules/notifications/service.js", () => ({
  notify: vi.fn(async (userId: string, _type: string, title: string, message: string) => {
    h.notifications.push({ userId, title, message });
  }),
}));

vi.mock("../modules/ws/hub.js", () => ({
  broadcast: vi.fn((event: string, payload: unknown) => {
    h.broadcasts.push({ event, payload });
  }),
}));

vi.mock("../modules/incidents/service.js", () => ({
  reportIncident: vi.fn(async (incident: { dedupeKey: string; severity: string }) => {
    h.incidents.push(incident);
    return incident;
  }),
}));

vi.mock("../modules/trading/execution-comparison.js", () => ({
  finalizeExecutionComparison: vi.fn(async (input: Record<string, unknown>) => {
    h.comparisons.push(input);
    return input;
  }),
}));

const { syncClosedTrades } = await import("../modules/trading/reconciliation.js");

beforeEach(() => {
  Object.assign(h, {
    account: { login: "100" },
    open: [],
    backfill: [],
    positions: [],
    deals: [],
    historyRejects: false,
    updates: [],
    findManyCalls: [],
    notifications: [],
    broadcasts: [],
    errors: [],
    incidents: [],
    comparisons: [],
  });
});

describe("syncClosedTrades", () => {
  it("closes a missing broker position with summed position deal profit", async () => {
    h.open = [{ id: "t1", userId: "u1", symbol: "EURUSD", mt5Ticket: "pos1" }];
    h.deals = [
      { ticket: "deal1", position_id: "pos1", profit: 10.25 },
      { ticket: "deal2", position_id: "pos1", profit: -2.5 },
      { ticket: "deal3", position_id: "other", profit: 100 },
    ];

    await syncClosedTrades();

    expect(h.findManyCalls[0]).toMatchObject({
      status: "EXECUTED",
      OR: [{ accountId: null }, { account: { login: "100" } }],
    });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      id: "t1",
      data: { status: "CLOSED", profit: 7.75, attributionConfidence: 1, attributionReason: "unique_position_match" },
    });
    expect(h.updates[0].data.closedAt).toBeInstanceOf(Date);
    expect(h.notifications).toHaveLength(1);
    expect(h.broadcasts).toEqual([{ event: "trade", payload: { tradeId: "t1", status: "CLOSED" } }]);
  });

  it("does not duplicate profit when multiple bot trades map to one netted position", async () => {
    h.open = [
      { id: "t1", userId: "u1", symbol: "EURUSD", mt5Ticket: "pos1" },
      { id: "t2", userId: "u1", symbol: "EURUSD", mt5Ticket: "pos1" },
    ];
    h.deals = [{ ticket: "deal1", position_id: "pos1", profit: 25 }];

    await syncClosedTrades();

    expect(h.updates).toHaveLength(2);
    for (const update of h.updates) {
      expect(update.data).toMatchObject({
        status: "CLOSED",
        profit: null,
        attributionConfidence: 0,
        attributionReason: "ambiguous_netting_position",
      });
    }
    expect(h.incidents).toContainEqual(expect.objectContaining({
      dedupeKey: "reconciliation:ambiguous:pos1",
      severity: "CRITICAL",
    }));
    expect(h.comparisons).toHaveLength(0);
  });

  it("records an unattributed closure and leaves profit null when history is unavailable", async () => {
    h.open = [{ id: "t1", userId: "u1", symbol: "EURUSD", mt5Ticket: "pos1" }];
    h.historyRejects = true;

    await syncClosedTrades();

    expect(h.updates[0]).toMatchObject({ id: "t1", data: { status: "CLOSED", profit: null } });
    expect(h.errors).toContainEqual(
      expect.objectContaining({ source: "scheduler", message: "trade closed without attributable profit" }),
    );
    // Aggregated, loud signal that the whole deal feed came back empty (not just
    // one lagging closure) — added so this can't fail silently.
    expect(h.errors).toContainEqual(
      expect.objectContaining({ source: "reconciliation", message: "deal history empty while trades await attribution" }),
    );
    expect(h.incidents).toContainEqual(expect.objectContaining({
      dedupeKey: "reconciliation:unattributed:t1",
      severity: "CRITICAL",
    }));
    expect(h.incidents).toContainEqual(expect.objectContaining({
      dedupeKey: "reconciliation:deal-history-empty",
      severity: "CRITICAL",
    }));
  });

  it("backfills profit for a recently closed trade", async () => {
    h.backfill = [{ id: "t2", userId: "u1", symbol: "XAUUSD", mt5Ticket: "pos2" }];
    h.deals = [{ ticket: "pos2", profit: -4.2 }];

    await syncClosedTrades();

    expect(h.updates).toEqual([{ id: "t2", data: {
      profit: -4.2,
      attributionConfidence: 1,
      attributionReason: "unique_position_match",
      brokerExitPrice: null,
    } }]);
    expect(h.notifications).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
  });

  it("does nothing when account info is unavailable", async () => {
    h.account = null;

    await syncClosedTrades();

    expect(h.findManyCalls).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  });
});
