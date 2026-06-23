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
import { addClient } from "./modules/ws/hub.js";
import { createTelegramBot } from "./modules/telegram/bot.js";
import { startWorkers, stopWorkers } from "./workers/scheduler.js";
import { logError } from "./lib/audit.js";
import { disconnectRedis, redisAvailable } from "./lib/redis.js";
import { reportIncident, resolveIncidentByDedupeKey } from "./modules/incidents/service.js";

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

  app.get("/ws", { websocket: true }, (socket) => addClient(socket));

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

  app.setErrorHandler(async (err: Error & { statusCode?: number }, _req, reply) => {
    await logError("api", err.message, { stack: err.stack?.slice(0, 1000) });
    // Never leak internals to clients.
    reply.code(err.statusCode ?? 500).send({ error: err.statusCode ? err.message : "internal error" });
  });

  const bot = createTelegramBot();
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
    { port: config.PORT, mock: config.MT5_MOCK },
    "backend started",
  );
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
