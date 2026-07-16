import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { intelligenceDashboard, runDueSources, runSource, searchIntelligence } from "./service.js";
import { ensureSourceCatalogue } from "./catalogue.js";
import { generateResearchBrief } from "./briefs.js";
import { reviewPendingKnowledge } from "./approval.js";

export async function intelligenceRoutes(app: FastifyInstance) {
  app.get("/api/intelligence/dashboard", { preHandler: [app.authenticate] }, async () => { await ensureSourceCatalogue(); return intelligenceDashboard(); });
  app.get("/api/intelligence/search", { preHandler: [app.authenticate] }, async (req, reply) => {
    const query = z.object({ q: z.string().min(2).max(300), limit: z.coerce.number().int().min(1).max(100).default(20) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid search query" });
    return { items: await searchIntelligence(query.data.q, query.data.limit) };
  });
  app.post("/api/intelligence/refresh", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    const results = await runDueSources();
    await audit({ actor: req.user.email, userId: req.user.id, category: "news", action: "intelligence_refresh_requested", detail: { sources: results.length } });
    return { results };
  });
  app.post("/api/intelligence/sources/:id/run", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => runSource((req.params as { id: string }).id));
  app.patch("/api/intelligence/sources/:id", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const body = z.object({ enabled: z.boolean().optional(), approved: z.boolean().optional(), pollIntervalMin: z.number().int().min(5).max(10080).optional(), reliabilityScore: z.number().min(0).max(1).optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid source update" });
    const source = await prisma.intelligenceSource.update({ where: { id: (req.params as { id: string }).id }, data: body.data });
    await audit({ actor: req.user.email, userId: req.user.id, category: "news", action: "intelligence_source_updated", detail: { sourceId: source.id, patch: body.data } });
    return source;
  });
  app.patch("/api/intelligence/knowledge/:id", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({ action: z.enum(["APPROVE", "REJECT", "CORRECT"]), content: z.string().min(1).max(50_000).optional(), reason: z.string().min(2).max(1000) }).safeParse(req.body);
    if (!body.success || (body.data.action === "CORRECT" && !body.data.content)) return reply.code(400).send({ error: "invalid knowledge review" });
    const current = await prisma.knowledgeEntry.findUniqueOrThrow({ where: { id: (req.params as { id: string }).id } });
    const nextVersion = current.currentVersion + 1;
    const nextContent = body.data.content ?? current.content;
    const status = body.data.action === "REJECT" ? "REJECTED" : "APPROVED";
    const updated = await prisma.$transaction(async (tx) => {
      const entry = await tx.knowledgeEntry.update({ where: { id: current.id }, data: { content: nextContent, status, userApproved: status === "APPROVED", approvalMethod: "HUMAN", approvalDecision: body.data.action, approvalReason: body.data.reason, approvalConfidence: 1, approvedBy: req.user.email, approvedAt: new Date(), currentVersion: nextVersion, lastValidatedAt: new Date() } });
      await tx.knowledgeVersion.create({ data: { knowledgeEntryId: current.id, version: nextVersion, content: nextContent, confidence: current.confidence, verificationStatus: current.verificationStatus, changeReason: body.data.reason, provenance: current.provenance as never, changedBy: req.user.email } });
      return entry;
    });
    await audit({ actor: req.user.email, userId: req.user.id, category: "news", action: "knowledge_reviewed", detail: { id: current.id, action: body.data.action, reason: body.data.reason } });
    return updated;
  });
  app.post("/api/intelligence/knowledge/ai-review", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    const result = await reviewPendingKnowledge(50, true);
    await audit({ actor: req.user.email, userId: req.user.id, category: "ai", action: "knowledge_ai_review_requested", detail: result });
    return result;
  });
  app.delete("/api/intelligence/items/:id", { preHandler: [app.requireRole("ADMIN")] }, async (req) => {
    const id = (req.params as { id: string }).id;
    await prisma.intelligenceItem.delete({ where: { id } });
    await audit({ actor: req.user.email, userId: req.user.id, category: "news", action: "intelligence_item_deleted", detail: { id } });
    return { ok: true };
  });
  app.post("/api/intelligence/briefs/:type", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const type = String((req.params as { type: string }).type).toUpperCase();
    if (type !== "DAILY" && type !== "WEEKLY") return reply.code(400).send({ error: "type must be daily or weekly" });
    return generateResearchBrief(type);
  });
}
