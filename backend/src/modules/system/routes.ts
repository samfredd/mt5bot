import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { mt5 } from "../mt5/client.js";
import { aiHealth, availableProviders, getActiveProvider, isProviderName, setActiveProvider } from "../ai/service.js";
import { updateProviderConfig } from "../ai/provider-config.js";
import { getBotState, setBotState } from "../system/state.js";
import { emergencyStopAll } from "../trading/service.js";
import { notify } from "../notifications/service.js";
import { audit } from "../../lib/audit.js";
import { operationalHealth } from "../../lib/operational-health.js";
import { resolveIncidentByDedupeKey } from "../incidents/service.js";

export async function systemRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    const [bridge, ai, operational] = await Promise.all([
      mt5.health().catch(() => ({ ok: false, mock: false, connected: false })),
      aiHealth(),
      operationalHealth(),
    ]);
    // `ok` must reflect actual dependency health — a bot that can't reach its
    // AI vetoes every trade, so reporting ok:true there is a false positive.
    const degraded: string[] = [];
    if (!bridge.connected) degraded.push("mt5_bridge");
    if (!operational.redis) degraded.push("redis");
    if (!ai.reachable) degraded.push("ai_unreachable");
    else if (!ai.modelPresent) degraded.push("ai_model_missing");
    for (const circuit of operational.circuits.filter((item) => item.status === "open")) {
      degraded.push(`${circuit.dependency}_circuit`);
    }
    if (operational.redis) {
      await Promise.all([
        resolveIncidentByDedupeKey("redis:startup-unavailable", "system"),
        resolveIncidentByDedupeKey("redis:trading-unavailable", "system"),
      ]).catch(() => undefined);
    }
    if (bridge.connected && !operational.circuits.some((item) => item.dependency === "mt5" && item.status === "open")) {
      await resolveIncidentByDedupeKey("mt5:circuit-open", "system").catch(() => undefined);
    }
    return {
      ok: degraded.length === 0,
      degraded,
      mt5Bridge: bridge,
      ai,
      operational,
      ollama: ai.reachable, // back-compat
      time: new Date().toISOString(),
    };
  });

  app.get("/api/bot/state", { preHandler: [app.authenticate] }, async () => getBotState());

  // --- AI provider: one active provider, switched + configured live (no restart) ---
  app.get("/api/ai/provider", { preHandler: [app.authenticate] }, async () => {
    const [active, providers] = await Promise.all([getActiveProvider(), availableProviders()]);
    return { active, providers };
  });

  app.put("/api/ai/provider", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const body = z.object({ provider: z.string() }).safeParse(req.body);
    if (!body.success || !isProviderName(body.data.provider)) {
      return reply.code(400).send({ error: "provider must be one of: ollama, anthropic, openai, openrouter" });
    }
    const provider = body.data.provider;
    const entry = (await availableProviders()).find((p) => p.name === provider);
    if (!entry?.configured) {
      return reply.code(409).send({ error: `${provider} is not configured — set its API key and model first` });
    }
    await setActiveProvider(provider);
    await audit({ actor: req.user.email, userId: req.user.id, category: "system", action: "ai_provider_switched", detail: { provider } });
    return { active: provider, providers: await availableProviders() };
  });

  // Edit a provider's key/model/baseUrl from the UI (key encrypted, never returned).
  app.put("/api/ai/provider-config", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const body = z.object({
      provider: z.string(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
      clearKey: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success || !isProviderName(body.data.provider)) {
      return reply.code(400).send({ error: "invalid provider configuration" });
    }
    const { provider, ...patch } = body.data;
    await updateProviderConfig(provider, patch);
    await audit({
      actor: req.user.email, userId: req.user.id, category: "system", action: "ai_provider_config_updated",
      detail: { provider, model: patch.model, baseUrl: patch.baseUrl, keyChanged: Boolean(patch.apiKey) || Boolean(patch.clearKey) },
    });
    return { active: await getActiveProvider(), providers: await availableProviders() };
  });

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

  // Live-trading gate toggles (admin-only). These move the former env/hardcoded
  // gates into Settings. NOTE: enabling these lets the bot place REAL-MONEY
  // orders on a real account — the change is audited.
  app.put("/api/bot/live-settings", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const body = z.object({
      liveTradingEnabled: z.boolean().optional(),
      requireLiveTwoFactor: z.boolean().optional(),
      autoLiveAuthorized: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid live-settings payload" });
    // Keep demoMode in lockstep with the live master switch (as /auth/live/enable
    // does): otherwise a stale demoMode=true wrongly blocks manual live trades.
    const patch = body.data.liveTradingEnabled === undefined
      ? body.data
      : { ...body.data, demoMode: !body.data.liveTradingEnabled };
    const next = await setBotState(patch, req.user.email);
    await audit({
      actor: req.user.email, userId: req.user.id, category: "system", action: "live_settings_changed",
      detail: {
        patch: body.data,
        liveTradingEnabled: next.liveTradingEnabled,
        requireLiveTwoFactor: next.requireLiveTwoFactor,
        autoLiveAuthorized: next.autoLiveAuthorized,
      },
    });
    return next;
  });

  app.post("/api/bot/paper-forward", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid paper-forward setting" });
    return setBotState({ paperForward: body.data.enabled }, req.user.email);
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
