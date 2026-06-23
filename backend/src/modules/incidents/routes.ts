import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { acknowledgeIncident, listIncidents, resolveIncident } from "./service.js";

export async function incidentRoutes(app: FastifyInstance) {
  app.get("/api/incidents", { preHandler: [app.authenticate] }, async (req) => {
    const query = z.object({
      status: z.enum(["ACTIVE", "OPEN", "ACKNOWLEDGED", "RESOLVED", "ALL"]).optional(),
      limit: z.coerce.number().int().positive().max(500).optional(),
    }).parse(req.query);
    return listIncidents(query);
  });

  app.post("/api/incidents/:id/acknowledge", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return acknowledgeIncident(id, req.user.email);
  });

  app.post("/api/incidents/:id/resolve", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return resolveIncident(id, req.user.email);
  });
}
