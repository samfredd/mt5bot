import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { authPlugin } from "./modules/auth/plugin.js";
import { authRoutes } from "./modules/auth/routes.js";
import { systemRoutes } from "./modules/system/routes.js";
import { tradingRoutes } from "./modules/trading/routes.js";
import { strategyRoutes } from "./modules/strategy/routes.js";
import { copyRoutes } from "./modules/copy/routes.js";
import { newsRoutes } from "./modules/news/routes.js";
import { analyticsRoutes } from "./modules/analytics/routes.js";
import { mt5Routes } from "./modules/mt5/routes.js";
import { backtestRoutes } from "./modules/backtest/routes.js";
import { whatsappRoutes } from "./modules/whatsapp/routes.js";
import { incidentRoutes } from "./modules/incidents/routes.js";
import { sentimentRoutes } from "./modules/sentiment/routes.js";
import { journalRoutes } from "./modules/journal/routes.js";
import { scalpingRoutes } from "./modules/scalping/scalping.routes.js";
import { assistantRoutes } from "./modules/assistant/routes.js";
import { mcpRoutes } from "./modules/mcp/server.js";
import { memoryRoutes } from "./modules/memory/routes.js";
import { intelligenceRoutes } from "./modules/intelligence/routes.js";
import { addClient } from "./modules/ws/hub.js";
import { createTelegramBot } from "./modules/telegram/bot.js";
import { startWorkers, stopWorkers } from "./workers/scheduler.js";
import { logError } from "./lib/audit.js";
import { disconnectRedis, redisAvailable } from "./lib/redis.js";
import { reportIncident, resolveIncidentByDedupeKey } from "./modules/incidents/service.js";
import { ZodError } from "zod";
import { validationFailure } from "./lib/validation.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function redisAvailableWithin(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await redisAvailable()) return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  const app = Fastify({ loggerInstance: logger });

  await app.register(cors, {
    // In development allow any localhost port (preview/dev servers).
    origin: config.NODE_ENV === "production" ? [config.FRONTEND_URL] : /^https?:\/\/localhost(:\d+)?$/,
    credentials: true,
  });
  await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
  await app.register(websocket);
  // Applied directly on the root instance (not via register) so the
  // authenticate/requireRole decorators are visible to all route plugins.
  // Cast erases the pino-specific logger generic; runtime shape is identical.
  await authPlugin(app as unknown as Parameters<typeof authPlugin>[0]);

  // Twilio posts form-encoded bodies.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Tolerate empty JSON bodies: browsers/clients often send
  // content-type: application/json on body-less POSTs (e.g. /api/bot/start),
  // which Fastify's default parser rejects with a 400.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";
    if (text === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("invalid JSON body") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Normalize every JSON failure, including older routes that still return only
  // `{ error }`. Validation routes can supply richer field-level issues; this
  // hook guarantees the UI always has a reason, next action, and traceable ID.
  app.addHook("onSend", async (req, reply, payload) => {
    if (reply.statusCode < 400 || typeof payload !== "string") return payload;
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (!contentType.includes("application/json")) return payload;
    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      if (typeof data.error !== "string") return payload;
      const action = reply.statusCode === 401
        ? "Sign in again and retry."
        : reply.statusCode === 403
          ? "Use an account with the required role or ask an administrator."
          : reply.statusCode === 404
            ? "Refresh the page and verify that the item still exists."
            : reply.statusCode === 409
              ? "Review the conflicting system state, correct it, and retry."
              : reply.statusCode >= 500
                ? "Retry once, then open Activity and use the request reference to inspect the recorded error."
                : "Correct the invalid values listed in the response and retry.";
      return JSON.stringify({
        ...data,
        reason: typeof data.reason === "string" ? data.reason : data.error,
        action: typeof data.action === "string" ? data.action : action,
        requestId: typeof data.requestId === "string" ? data.requestId : req.id,
      });
    } catch {
      return payload;
    }
  });

  app.get("/ws", {
    websocket: true,
    preHandler: [async (req, reply) => {
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
      const token = protocols.find((value) => value.split(".").length === 3);
      if (token) req.headers.authorization = `Bearer ${token}`;
      await app.authenticate(req, reply);
    }],
  }, (socket) => addClient(socket));

  await app.register(authRoutes);
  await app.register(systemRoutes);
  await app.register(tradingRoutes);
  await app.register(strategyRoutes);
  await app.register(copyRoutes);
  await app.register(newsRoutes);
  await app.register(analyticsRoutes);
  await app.register(mt5Routes);
  await app.register(backtestRoutes);
  await app.register(whatsappRoutes);
  await app.register(incidentRoutes);
  await app.register(sentimentRoutes);
  await app.register(journalRoutes);
  await app.register(scalpingRoutes);
  await app.register(assistantRoutes);
  await app.register(memoryRoutes);
  await app.register(intelligenceRoutes);
  await app.register(mcpRoutes);

  app.setErrorHandler(async (err: Error & { statusCode?: number }, req, reply) => {
    const requestId = req.id;
    await logError("api", err.message, { requestId, method: req.method, url: req.url, stack: err.stack?.slice(0, 1000) });
    if (err instanceof ZodError) {
      return reply.code(400).send({ ...validationFailure("Invalid request", err), requestId });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: err.message,
        reason: err.message,
        action: err.statusCode === 401 ? "Sign in again and retry." : err.statusCode === 403 ? "Use an account with the required role or ask an administrator." : "Correct the request and retry.",
        requestId,
      });
    }
    // Do not expose stack traces, credentials, or broker internals. The request
    // reference links the full server-side ErrorLog to the UI-visible failure.
    reply.code(500).send({
      error: "Internal server error",
      reason: "The server could not complete this operation. Full technical details were recorded securely.",
      action: "Retry once. If it fails again, open Activity and use this reference when reviewing the error log.",
      requestId,
    });
  });

  const bot = await createTelegramBot();
  if (bot) {
    bot.start().catch((err) => logger.error({ err: String(err) }, "telegram bot failed to start"));
  }

  if (await redisAvailableWithin(5_000)) {
    await resolveIncidentByDedupeKey("redis:startup-unavailable", "system").catch(() => undefined);
  } else {
    await reportIncident({
      dedupeKey: "redis:startup-unavailable",
      severity: "CRITICAL",
      source: "redis",
      title: "Redis unavailable at startup",
      message: "New trading and leased background jobs remain fail-closed until Redis recovers.",
      minIntervalMs: 5 * 60_000,
    }).catch((error) => logger.error({ error: String(error) }, "failed to persist Redis startup incident"));
  }
  startWorkers();

  const shutdown = async () => {
    stopWorkers();
    if (bot) await bot.stop();
    await app.close();
    await disconnectRedis();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info(
    { port: config.PORT },
    "backend started",
  );
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
