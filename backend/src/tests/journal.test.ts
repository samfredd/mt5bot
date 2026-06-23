import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  trades: [{ id: "t1", userId: "u1" }] as Record<string, unknown>[],
  entries: [] as Record<string, any>[],
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    trade: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
        h.trades.find((trade) => trade.id === where.id && trade.userId === where.userId) ?? null),
    },
    tradeJournalEntry: {
      upsert: vi.fn(async ({ where, create, update }: { where: { userId_tradeId: { userId: string; tradeId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const key = where.userId_tradeId;
        const existing = h.entries.find((entry) => entry.userId === key.userId && entry.tradeId === key.tradeId);
        if (existing) return Object.assign(existing, update);
        const entry = { id: `j${h.entries.length + 1}`, ...create };
        h.entries.push(entry);
        return entry;
      }),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => h.entries.filter((entry) => entry.userId === where.userId)),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; tradeId: string } }) => {
        const before = h.entries.length;
        h.entries = h.entries.filter((entry) => entry.userId !== where.userId || entry.tradeId !== where.tradeId);
        return { count: before - h.entries.length };
      }),
    },
  },
}));

const { deleteJournalEntry, listJournalEntries, upsertJournalEntry } = await import("../modules/journal/service.js");

beforeEach(() => {
  h.trades = [{ id: "t1", userId: "u1" }];
  h.entries = [];
});

describe("trade journal", () => {
  it("stores notes, tags, lessons, and rating for an owned trade", async () => {
    await expect(upsertJournalEntry("u1", "t1", {
      notes: "Waited for confirmation",
      tags: ["discipline", "london"],
      lessons: "Avoid chasing the first candle",
      rating: 4,
    })).resolves.toMatchObject({
      userId: "u1",
      tradeId: "t1",
      tags: ["discipline", "london"],
      rating: 4,
    });
  });

  it("rejects a trade owned by another user", async () => {
    await expect(upsertJournalEntry("u2", "t1", { notes: "no", tags: [], lessons: "", rating: null }))
      .rejects.toThrow("trade not found");
  });

  it("lists and deletes only the current user's entries", async () => {
    h.entries = [
      { id: "j1", userId: "u1", tradeId: "t1" },
      { id: "j2", userId: "u2", tradeId: "t2" },
    ];
    await expect(listJournalEntries("u1")).resolves.toEqual([{ id: "j1", userId: "u1", tradeId: "t1" }]);
    await expect(deleteJournalEntry("u1", "t1")).resolves.toEqual({ count: 1 });
  });
});
