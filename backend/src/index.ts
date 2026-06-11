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
import { whatsappRoutes } from "./modules/whatsapp/routes.js";
import { addClient } from "./modules/ws/hub.js";
import { createTelegramBot } from "./modules/telegram/bot.js";
import { startWorkers, stopWorkers } from "./workers/scheduler.js";
import { logError } from "./lib/audit.js";

async function main() {
  const app = Fastify({ loggerInstance: logger });

  await app.register(cors, { origin: [config.FRONTEND_URL], credentials: true });
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
  await app.register(whatsappRoutes);

  app.setErrorHandler(async (err: Error & { statusCode?: number }, _req, reply) => {
    await logError("api", err.message, { stack: err.stack?.slice(0, 1000) });
    // Never leak internals to clients.
    reply.code(err.statusCode ?? 500).send({ error: err.statusCode ? err.message : "internal error" });
  });

  const bot = createTelegramBot();
  if (bot) {
    bot.start().catch((err) => logger.error({ err: String(err) }, "telegram bot failed to start"));
  }

  startWorkers();

  const shutdown = async () => {
    stopWorkers();
    if (bot) await bot.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info(
    { port: config.PORT, demoMode: config.DEMO_MODE, liveTrading: config.LIVE_TRADING_ENABLED, mock: config.MT5_MOCK },
    "backend started",
  );
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
