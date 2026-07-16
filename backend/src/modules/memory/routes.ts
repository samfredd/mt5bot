import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { backfillTradeMemories, memorySummary } from "./service.js";

export async function memoryRoutes(app: FastifyInstance) {
  app.get("/api/trading-memory", { preHandler: [app.authenticate] }, async (req) => memorySummary(req.user.id));

  app.post("/api/trading-memory/rebuild", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({ limit: z.number().int().min(1).max(500).default(500) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid rebuild request" });
    const learned = await backfillTradeMemories(req.user.id, body.data.limit);
    await audit({ actor: req.user.email, userId: req.user.id, category: "ai", action: "trading_memory_rebuilt", detail: { learned } });
    return { learned, summary: await memorySummary(req.user.id) };
  });
}
