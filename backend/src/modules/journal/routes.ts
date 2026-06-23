import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deleteJournalEntry, listJournalEntries, upsertJournalEntry } from "./service.js";

const JournalBody = z.object({
  notes: z.string().max(5000).default(""),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  lessons: z.string().max(5000).default(""),
  rating: z.number().int().min(1).max(5).nullable().default(null),
});

export async function journalRoutes(app: FastifyInstance) {
  app.get("/api/journal", { preHandler: [app.authenticate] }, async (req) => listJournalEntries(req.user.id));

  app.put("/api/trades/:tradeId/journal", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { tradeId } = req.params as { tradeId: string };
    const body = JournalBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid journal entry", issues: body.error.issues });
    try {
      return await upsertJournalEntry(req.user.id, tradeId, body.data);
    } catch (error) {
      if (error instanceof Error && error.message === "trade not found") return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/trades/:tradeId/journal", { preHandler: [app.authenticate] }, async (req) => {
    const { tradeId } = req.params as { tradeId: string };
    return deleteJournalEntry(req.user.id, tradeId);
  });
}
