import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { latestNews, refreshCalendar, assessNewsRisk } from "./service.js";
import { refreshHeadlines } from "./headlines.js";

export async function newsRoutes(app: FastifyInstance) {
  app.get("/api/news", { preHandler: [app.authenticate] }, async () => latestNews(30));

  app.post("/api/news/refresh", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async () => {
    const [calendar, headlines] = await Promise.all([refreshCalendar(), refreshHeadlines()]);
    return { ok: true, calendar, headlines };
  });

  app.get("/api/news/risk/:symbol", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const settings = await prisma.riskSettings.findUnique({ where: { userId: req.user.id } });
    if (!settings) return reply.code(409).send({ error: "risk settings not configured" });
    return assessNewsRisk(symbol, settings);
  });
}
