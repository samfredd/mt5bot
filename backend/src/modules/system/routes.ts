import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { mt5 } from "../mt5/client.js";
import { aiHealth, availableProviders, getActiveProvider, isAiMode, isProviderName, PURE_LOGIC_PROVIDER, setActiveProvider } from "../ai/service.js";
import { updateProviderConfig } from "../ai/provider-config.js";
import { fetchProviderModels } from "../ai/model-catalog.js";
import { getBotState, setBotState } from "../system/state.js";
import { emergencyStopAll } from "../trading/service.js";
import { notify } from "../notifications/service.js";
import { audit } from "../../lib/audit.js";
import { operationalHealth } from "../../lib/operational-health.js";
import { resolveIncidentByDedupeKey } from "../incidents/service.js";
import { OperationalConfigSchema, createMcpAccessToken, getOperationalConfigSummary, revokeMcpAccessToken, updateOperationalConfig } from "./operational-config.js";
import { settingFailure, validationFailure } from "../../lib/validation.js";

function actionsForNotification(type: string) {
  if (/approval/.test(type)) return [{ label: "Review trade", href: "/dashboard?tab=Trades" }, { label: "Open settings", href: "/dashboard?tab=Settings" }];
  if (/trade|profit|loss|stop/.test(type)) return [{ label: "View trades", href: "/dashboard?tab=Trades" }, { label: "View activity", href: "/dashboard?tab=Activity" }];
  if (/news/.test(type)) return [{ label: "Open news", href: "/dashboard?tab=News" }, { label: "Review settings", href: "/dashboard?tab=Settings" }];
  if (/error|risk|emergency|paused/.test(type)) return [{ label: "View incidents", href: "/dashboard?tab=Activity" }, { label: "Review settings", href: "/dashboard?tab=Settings" }];
  return [{ label: "View activity", href: "/dashboard?tab=Activity" }];
}

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
    if (ai.provider !== PURE_LOGIC_PROVIDER) {
      if (!ai.reachable) degraded.push("ai_unreachable");
      else if (!ai.modelPresent) degraded.push("ai_model_missing");
    }
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

  // Operational settings deliberately live in Postgres, not .env. Secrets are
  // encrypted at rest and the GET response returns only their presence flags.
  app.get("/api/system/operational-settings", { preHandler: [app.requireRole("ADMIN")] }, async () => getOperationalConfigSummary());

  app.get("/api/system/ui-settings", { preHandler: [app.authenticate] }, async () => {
    const config = await getOperationalConfigSummary();
    return {
      toastDefaultDurationMs: config.toastDefaultDurationMs,
      toastErrorDurationMs: config.toastErrorDurationMs,
      toastStackLimit: config.toastStackLimit,
    };
  });

  app.put("/api/system/operational-settings", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const body = z.intersection(
      OperationalConfigSchema.partial(),
      z.object({
        mt5BridgeApiKey: z.string().max(500).optional(),
        telegramBotToken: z.string().max(500).optional(),
        twilioAccountSid: z.string().max(500).optional(),
        twilioAuthToken: z.string().max(500).optional(),
        webSearchApiKey: z.string().max(500).optional(),
        youtubeApiKey: z.string().max(500).optional(),
        githubToken: z.string().max(500).optional(),
        xBearerToken: z.string().max(1000).optional(),
        clearMt5BridgeApiKey: z.boolean().optional(),
        clearTelegramBotToken: z.boolean().optional(),
        clearTwilioAccountSid: z.boolean().optional(),
        clearTwilioAuthToken: z.boolean().optional(),
        clearWebSearchApiKey: z.boolean().optional(),
        clearYoutubeApiKey: z.boolean().optional(),
        clearGithubToken: z.boolean().optional(),
        clearXBearerToken: z.boolean().optional(),
      }),
    ).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(validationFailure("Invalid operational settings", body.error));
    const next = await updateOperationalConfig(body.data);
    await audit({
      actor: req.user.email,
      userId: req.user.id,
      category: "system",
      action: "operational_settings_updated",
      detail: {
        ...body.data,
        mt5BridgeApiKey: body.data.mt5BridgeApiKey ? "[updated]" : undefined,
        telegramBotToken: body.data.telegramBotToken ? "[updated]" : undefined,
        twilioAccountSid: body.data.twilioAccountSid ? "[updated]" : undefined,
        twilioAuthToken: body.data.twilioAuthToken ? "[updated]" : undefined,
        webSearchApiKey: body.data.webSearchApiKey ? "[updated]" : undefined,
        youtubeApiKey: body.data.youtubeApiKey ? "[updated]" : undefined,
        githubToken: body.data.githubToken ? "[updated]" : undefined,
        xBearerToken: body.data.xBearerToken ? "[updated]" : undefined,
      },
    });
    return next;
  });

  app.post("/api/system/mcp-token", { preHandler: [app.requireRole("ADMIN")] }, async (req) => {
    const generated = await createMcpAccessToken(req.user.id);
    await updateOperationalConfig({ mcpEnabled: true });
    await audit({
      actor: req.user.email,
      userId: req.user.id,
      category: "system",
      action: "mcp_access_token_rotated",
      detail: { createdAt: generated.createdAt },
    });
    return {
      token: generated.token,
      createdAt: generated.createdAt,
      warning: "Copy this token now. It will not be shown again.",
    };
  });

  app.delete("/api/system/mcp-token", { preHandler: [app.requireRole("ADMIN")] }, async (req) => {
    await revokeMcpAccessToken();
    await updateOperationalConfig({ mcpEnabled: false });
    await audit({ actor: req.user.email, userId: req.user.id, category: "system", action: "mcp_access_revoked" });
    return { ok: true };
  });

  // --- AI provider: one active provider, switched + configured live (no restart) ---
  app.get("/api/ai/provider", { preHandler: [app.authenticate] }, async () => {
    const [active, providers] = await Promise.all([getActiveProvider(), availableProviders()]);
    return { active, providers };
  });

  app.get("/api/ai/provider-models/:provider", { preHandler: [app.authenticate] }, async (req, reply) => {
    const params = z.object({ provider: z.string() }).safeParse(req.params);
    if (!params.success || !isProviderName(params.data.provider)) {
      return reply.code(400).send(params.success
        ? settingFailure("provider", `unsupported provider "${params.data.provider}"`, "Select a provider shown in Settings.")
        : validationFailure("Invalid AI provider", params.error));
    }
    try {
      const models = await fetchProviderModels(params.data.provider);
      return { provider: params.data.provider, models };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "could not load provider models" });
    }
  });

  app.put("/api/ai/provider", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const body = z.object({ provider: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send(validationFailure("Invalid AI provider setting", body.error));
    if (!isAiMode(body.data.provider)) {
      return reply.code(400).send(settingFailure("provider", `"${body.data.provider}" is not supported`, "Choose pure_logic, ollama, anthropic, openai, openrouter, or nvidia."));
    }
    const provider = body.data.provider;
    const entry = isProviderName(provider) ? (await availableProviders()).find((p) => p.name === provider) : undefined;
    if (provider !== PURE_LOGIC_PROVIDER && !entry?.configured) {
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
      return reply.code(400).send(body.success
        ? settingFailure("provider", `"${body.data.provider}" is not supported`, "Select a provider shown in Settings.")
        : validationFailure("Invalid provider configuration", body.error));
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
    if (!body.success) return reply.code(400).send(validationFailure("Invalid bot mode", body.error));
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
      adaptiveRiskEnabled: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(validationFailure("Invalid live-trading settings", body.error));
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
        adaptiveRiskEnabled: next.adaptiveRiskEnabled,
      },
    });
    return next;
  });

  app.post("/api/bot/paper-forward", { preHandler: [app.requireRole("ADMIN", "MANAGER")] }, async (req, reply) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send(validationFailure("Invalid paper-trading setting", body.error));
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
    const { notificationHistoryLimit } = await getOperationalConfigSummary();
    const rows = await prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: notificationHistoryLimit });
    return rows.map((row) => ({ ...row, actions: actionsForNotification(row.type) }));
  });

  app.get("/api/notifications/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send(validationFailure("Invalid notification reference", parsed.error));
    const row = await prisma.notification.findFirst({ where: { id: parsed.data.id, userId: req.user.id } });
    if (!row) return reply.code(404).send({ error: "Notification not found", reason: "The notification was removed or does not belong to this account.", action: "Refresh the notification center." });
    return { ...row, actions: actionsForNotification(row.type) };
  });

  app.put("/api/notifications/prefs", { preHandler: [app.authenticate] }, async (req) => {
    const prefs = z.record(z.boolean()).parse(req.body);
    await prisma.user.update({ where: { id: req.user.id }, data: { notificationPrefs: prefs } });
    return { ok: true, prefs };
  });
}
