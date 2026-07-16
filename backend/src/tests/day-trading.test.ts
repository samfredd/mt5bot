import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: { enabled: false, closeHourUtc: 20, closeMinuteUtc: 45 } as Record<string, unknown>,
  positions: [] as { ticket: string }[],
  closed: [] as string[],
  audits: [] as string[],
  notes: 0,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(async () => ({ key: "day_trading", value: h.config })),
      upsert: vi.fn(async () => ({})),
    },
    user: { findFirst: vi.fn(async () => ({ id: "admin", email: "a@x.com", role: "ADMIN" })) },
    trade: { findMany: vi.fn(async () => h.positions.map((position) => ({ mt5Ticket: position.ticket }))) },
  },
}));
vi.mock("../lib/audit.js", () => ({ audit: vi.fn(async ({ action }: { action: string }) => { h.audits.push(action); }), logError: vi.fn(async () => {}) }));
vi.mock("../modules/mt5/client.js", () => ({
  mt5: {
    positions: vi.fn(async () => h.positions),
    closePosition: vi.fn(async (ticket: string) => { h.closed.push(ticket); return { ok: true }; }),
  },
}));
vi.mock("../modules/notifications/service.js", () => ({ notify: vi.fn(async () => { h.notes++; }) }));
vi.mock("../modules/ws/hub.js", () => ({ broadcast: vi.fn() }));

const { isPastDailyClose, dayTradingBlocksEntryAt, enforceDayTradingExit } = await import("../modules/trading/day-trading.js");

beforeEach(() => {
  h.config = { enabled: false, closeHourUtc: 20, closeMinuteUtc: 45 };
  h.positions = [];
  h.closed = [];
  h.audits = [];
  h.notes = 0;
});

const at = (h: number, m: number) => new Date(Date.UTC(2026, 5, 15, h, m));

describe("isPastDailyClose", () => {
  it("is false before the cutoff", () => {
    expect(isPastDailyClose(at(20, 44), 20, 45)).toBe(false);
    expect(isPastDailyClose(at(9, 0), 20, 45)).toBe(false);
  });
  it("is true at and after the cutoff", () => {
    expect(isPastDailyClose(at(20, 45), 20, 45)).toBe(true);
    expect(isPastDailyClose(at(23, 59), 20, 45)).toBe(true);
  });
});

describe("dayTradingBlocksEntryAt", () => {
  const cfg = { enabled: true, closeHourUtc: 20, closeMinuteUtc: 0 };
  it("blocks entries only when enabled AND past the cutoff", () => {
    expect(dayTradingBlocksEntryAt(cfg, at(20, 30))).toBe(true);
    expect(dayTradingBlocksEntryAt(cfg, at(19, 30))).toBe(false);
    expect(dayTradingBlocksEntryAt({ ...cfg, enabled: false }, at(21, 0))).toBe(false);
  });
});

describe("enforceDayTradingExit", () => {
  it("does nothing when disabled", async () => {
    h.config = { enabled: false, closeHourUtc: 20, closeMinuteUtc: 0 };
    h.positions = [{ ticket: "p1" }];
    expect(await enforceDayTradingExit(at(21, 0))).toEqual([]);
    expect(h.closed).toEqual([]);
  });
  it("does nothing before the cutoff", async () => {
    h.config = { enabled: true, closeHourUtc: 20, closeMinuteUtc: 0 };
    h.positions = [{ ticket: "p1" }];
    expect(await enforceDayTradingExit(at(19, 59))).toEqual([]);
    expect(h.closed).toEqual([]);
  });
  it("flattens all positions past the cutoff and notifies", async () => {
    h.config = { enabled: true, closeHourUtc: 20, closeMinuteUtc: 0 };
    h.positions = [{ ticket: "p1" }, { ticket: "p2" }];
    const closed = await enforceDayTradingExit(at(20, 1));
    expect(closed).toEqual(["p1", "p2"]);
    expect(h.closed).toEqual(["p1", "p2"]);
    expect(h.audits).toContain("day_trading_flatten");
    expect(h.notes).toBe(1);
  });
  it("is a no-op (idempotent) when nothing is open past the cutoff", async () => {
    h.config = { enabled: true, closeHourUtc: 20, closeMinuteUtc: 0 };
    h.positions = [];
    expect(await enforceDayTradingExit(at(22, 0))).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});
