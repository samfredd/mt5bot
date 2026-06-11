import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { mt5 } from "../mt5/client.js";
import { ollamaHealthy } from "../ai/service.js";
import { getBotState, setBotState } from "../system/state.js";
import { emergencyStopAll } from "../trading/service.js";
import { notify } from "../notifications/service.js";
import { audit } from "../../lib/audit.js";

export async function systemRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    const [bridge, ollama] = await Promise.all([
      mt5.health().catch(() => ({ ok: false, mock: false, connected: false })),
      ollamaHealthy(),
    ]);
    return { ok: true, mt5Bridge: bridge, ollama, time: new Date().toISOString() };
  });

  app.get("/api/bot/state", { preHandler: [app.authenticate] }, async () => getBotState());

  app.post("/api/bot/start", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const state = await getBotState();
    if (state.emergencyStop) return reply.code(409).send({ error: "emergency stop is active — reset it first" });
    const settings = await prisma.riskSettings.findUnique({ where: { userId: req.user.id } });
    if (!settings) return reply.code(409).send({ error: "configure risk settings before starting the bot" });
    const next = await setBotState({ status: "running" }, req.user.email);
    await notify(req.user.id, "bot_resumed", "Bot started", `Mode: ${next.mode}, ${next.demoMode ? "DEMO" : "LIVE"}`);
    return next;
  });

  app.post("/api/bot/pause", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    const next = await setBotState({ status: "paused" }, req.user.email);
    await notify(req.user.id, "bot_paused", "Bot paused", "No new trades will be opened.");
    return next;
  });

  app.post("/api/bot/mode", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({ mode: z.enum(["MANUAL", "SEMI_AUTO", "AUTO", "COPY"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid mode" });
    return setBotState({ mode: body.data.mode }, req.user.email);
  });

  app.post("/api/bot/emergency-stop", { preHandler: [app.authenticate] }, async (req) => {
    // Deliberately allowed for ANY authenticated role — stopping must be easy.
    const closed = await emergencyStopAll(req.user.email, req.user.id);
    return { ok: true, closedPositions: closed };
  });

  app.post("/api/bot/emergency-reset", { preHandler: [app.requireRole("ADMIN")] }, async (req) => {
    const next = await setBotState({ emergencyStop: false, status: "paused" }, req.user.email);
    await audit({ actor: req.user.email, userId: req.user.id, category: "system", action: "emergency_stop_reset" });
    return next;
  });

  app.get("/api/audit", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    const { category, limit } = req.query as { category?: string; limit?: string };
    return prisma.auditLog.findMany({
      where: category ? { category } : undefined,
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit ?? 100), 500),
    });
  });

  app.get("/api/notifications", { preHandler: [app.authenticate] }, async (req) => {
    return prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: 50 });
  });

  app.put("/api/notifications/prefs", { preHandler: [app.authenticate] }, async (req) => {
    const prefs = z.record(z.boolean()).parse(req.body);
    await prisma.user.update({ where: { id: req.user.id }, data: { notificationPrefs: prefs } });
    return { ok: true, prefs };
  });
}
