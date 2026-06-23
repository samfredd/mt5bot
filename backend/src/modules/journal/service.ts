import { prisma } from "../../lib/prisma.js";

export interface JournalInput {
  notes: string;
  tags: string[];
  lessons: string;
  rating: number | null;
}

export async function upsertJournalEntry(userId: string, tradeId: string, input: JournalInput) {
  const trade = await prisma.trade.findFirst({ where: { id: tradeId, userId }, select: { id: true } });
  if (!trade) throw new Error("trade not found");
  return prisma.tradeJournalEntry.upsert({
    where: { userId_tradeId: { userId, tradeId } },
    create: { userId, tradeId, ...input, tags: input.tags },
    update: { ...input, tags: input.tags },
  });
}

export function listJournalEntries(userId: string) {
  return prisma.tradeJournalEntry.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: { trade: { select: { symbol: true, direction: true, profit: true, openedAt: true, closedAt: true } } },
  });
}

export function deleteJournalEntry(userId: string, tradeId: string) {
  return prisma.tradeJournalEntry.deleteMany({ where: { userId, tradeId } });
}
