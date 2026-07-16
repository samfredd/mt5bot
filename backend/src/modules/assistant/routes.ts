import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isProviderName } from "../ai/service.js";
import { chatWithAssistant, getAssistantConfig, saveAssistantConfig } from "./service.js";
import { settingFailure, validationFailure } from "../../lib/validation.js";

export async function assistantRoutes(app: FastifyInstance) {
  app.get("/api/assistant/settings", { preHandler: [app.authenticate] }, async () => getAssistantConfig());

  app.put("/api/assistant/settings", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const parsed = z.object({ enabled: z.boolean().optional(), providerMode: z.enum(["system", "separate"]).optional(), provider: z.string().optional(), model: z.string().max(200).optional(), telegramEnabled: z.boolean().optional(), whatsappEnabled: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(validationFailure("Invalid assistant settings", parsed.error));
    if (parsed.data.provider && !isProviderName(parsed.data.provider)) return reply.code(400).send(settingFailure("provider", `"${parsed.data.provider}" is not supported`, "Select a provider shown in the assistant settings dropdown."));
    return saveAssistantConfig(parsed.data as Parameters<typeof saveAssistantConfig>[0], req.user.email, req.user.id);
  });

  app.post("/api/assistant/chat", { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = z.object({
      message: z.string().max(4000).optional(),
      confirmToken: z.string().max(100).optional(),
      cancelToken: z.string().max(100).optional(),
      context: z.object({ page: z.enum(["Overview", "Trades", "Assistant", "Strategies", "Performance", "Activity", "Strategy Lab", "Backtest", "Paper Trades", "Copy Trading", "Journal", "News", "Evidence", "Settings", "Scalping Mode"]) }).optional(),
    }).refine((value) => Boolean(value.message || value.confirmToken || value.cancelToken)).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "message, confirmToken, or cancelToken is required" });
    return chatWithAssistant({ userId: req.user.id, actor: req.user.email, role: req.user.role, ...parsed.data, page: parsed.data.context?.page, channel: "web" });
  });
}
