import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { authenticator } from "otplib";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { getBotState, setBotState } from "../system/state.js";
import { registerUser, verifyLogin, verifyTotp, revokeUserTokens } from "./service.js";

const Credentials = z.object({ email: z.string().email(), password: z.string().min(8) });

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const body = Credentials.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid email or password (min 8 chars)" });
    const existing = await prisma.user.findUnique({ where: { email: body.data.email } });
    if (existing) return reply.code(409).send({ error: "email already registered" });
    const user = await registerUser(body.data.email, body.data.password);
    return { id: user.id, email: user.email, role: user.role };
  });

  // Tight per-route limit on login: brute-forcing credentials must not get
  // the global 200/min budget. Keyed by client IP.
  app.post("/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const body = Credentials.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid credentials" });
    const user = await verifyLogin(body.data.email, body.data.password);
    if (!user) return reply.code(401).send({ error: "invalid credentials" });
    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
    return { token, user: { id: user.id, email: user.email, role: user.role, totpEnabled: user.totpEnabled } };
  });

  // Logout = revoke every token issued to this user before now (all devices).
  app.post("/auth/logout", { preHandler: [app.authenticate] }, async (req) => {
    await revokeUserTokens(req.user.id);
    await audit({ actor: req.user.email, userId: req.user.id, category: "auth", action: "logout" });
    return { ok: true };
  });

  // --- 2FA setup ---
  app.post("/auth/2fa/setup", { preHandler: [app.authenticate] }, async (req) => {
    const secret = authenticator.generateSecret();
    await prisma.user.update({ where: { id: req.user.id }, data: { totpSecret: secret, totpEnabled: false } });
    return { secret, otpauthUrl: authenticator.keyuri(req.user.email, "MT5Bot", secret) };
  });

  app.post("/auth/2fa/enable", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.totpSecret || !verifyTotp(user.totpSecret, token)) {
      return reply.code(400).send({ error: "invalid 2FA token" });
    }
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
    await audit({ actor: req.user.email, userId: user.id, category: "auth", action: "2fa_enabled" });
    return { ok: true };
  });

  // --- Live trading enable: admin-only; TOTP required only when live 2FA is on ---
  app.post("/auth/live/enable", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const { token } = z.object({ token: z.string().optional() }).parse(req.body ?? {});
    if ((await getBotState()).requireLiveTwoFactor) {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user?.totpEnabled || !user.totpSecret || !token || !verifyTotp(user.totpSecret, token)) {
        return reply.code(403).send({ error: "valid 2FA token required to enable live trading" });
      }
    }
    await prisma.user.update({ where: { id: req.user.id }, data: { liveTradingEnabled: true } });
    await setBotState({ liveTradingEnabled: true, demoMode: false }, req.user.email);
    await audit({ actor: req.user.email, userId: req.user.id, category: "auth", action: "live_trading_enabled_by_user" });
    return { ok: true };
  });

  app.post("/auth/live/disable", { preHandler: [app.authenticate] }, async (req) => {
    await prisma.user.update({ where: { id: req.user.id }, data: { liveTradingEnabled: false } });
    await setBotState({ liveTradingEnabled: false, demoMode: true }, req.user.email);
    await audit({ actor: req.user.email, userId: req.user.id, category: "auth", action: "live_trading_disabled_by_user" });
    return { ok: true };
  });

  // --- Connector link codes (shown in dashboard, consumed in chat) ---
  app.post("/auth/link/telegram", { preHandler: [app.authenticate] }, async (req) => {
    const code = randomBytes(4).toString("hex");
    await prisma.telegramUser.create({ data: { userId: req.user.id, telegramId: `pending:${code}`, linkCode: code } });
    return { code, instructions: `Send "/link ${code}" to the Telegram bot.` };
  });

  app.post("/auth/link/whatsapp", { preHandler: [app.authenticate] }, async (req) => {
    const code = randomBytes(4).toString("hex");
    await prisma.whatsappUser.create({ data: { userId: req.user.id, phone: `pending:${code}`, linkCode: code } });
    return { code, instructions: `Send "link ${code}" to the WhatsApp number.` };
  });
}
