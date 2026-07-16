import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { encryptSecret } from "../../lib/crypto.js";
import { mt5 } from "./client.js";
import { accountIdForLogin, invalidateAccountCache } from "./account.js";
import { notify } from "../notifications/service.js";

export async function mt5Routes(app: FastifyInstance) {
  /** Saved accounts (passwords never returned) + what the terminal is connected to right now. */
  app.get("/api/mt5/accounts", { preHandler: [app.authenticate] }, async (req) => {
    const [user, current] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.user.id }, select: { liveTradingEnabled: true } }),
      mt5.accountInfo().catch(() => null),
    ]);
    // Immediately surface an account already logged into the MT5 terminal.
    // No password is requested or stored by this automatic registration.
    if (current) await accountIdForLogin(req.user.id, current.login, current);
    const saved = await prisma.mt5Account.findMany({
      where: { userId: req.user.id, archivedAt: null },
      // The encrypted value is used only to expose a boolean capability to
      // the UI. It is never included in the response.
      select: { id: true, label: true, login: true, server: true, isDemo: true, verified: true, passwordEnc: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    return {
      saved: saved.map(({ passwordEnc, ...account }) => ({ ...account, hasCredentials: Boolean(passwordEnc) })),
      current,
      activeAccountId: current ? saved.find((account) => account.login === String(current.login))?.id ?? null : null,
      userLiveEnabled: user?.liveTradingEnabled ?? false,
    };
  });

  /**
   * Connect the terminal to a different MT5 account (demo or real).
   * Credentials go straight to the bridge for the login call; only an
   * AES-encrypted copy is kept so the account can be reconnected later.
   */
  app.post("/api/mt5/connect", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const body = z.object({
      label: z.string().min(1).max(50).default("My account"),
      login: z.string().regex(/^\d+$/, "login must be the numeric MT5 account number"),
      password: z.string().min(4),
      server: z.string().min(2),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid payload" });
    const { label, login, password, server } = body.data;

    const result = await mt5.connect({ login, password, server }, req.user.email);
    if (!result.ok) {
      return reply.code(502).send({ error: `MT5 login failed: ${result.error ?? "unknown error"}. Check login, password, and exact server name.` });
    }

    invalidateAccountCache();
    // Match by (userId, login): the row may have been auto-registered (with an
    // unknown server) when the terminal was already logged into this account.
    // Keying on the unique makes this a single atomic upsert (no findFirst race).
    const account = await prisma.mt5Account.upsert({
      where: { userId_login: { userId: req.user.id, login } },
      create: {
        userId: req.user.id, label, login, server,
        isDemo: result.is_demo ?? true, verified: true, passwordEnc: encryptSecret(password),
      },
      update: { label, server, isDemo: result.is_demo ?? true, verified: true, passwordEnc: encryptSecret(password), archivedAt: null },
    });

    await audit({
      actor: req.user.email, userId: req.user.id, category: "mt5", action: "account_connected",
      detail: { login, server, isDemo: result.is_demo },
    });
    await notify(req.user.id, "bot_resumed", "MT5 account switched",
      `Terminal now connected to ${login} on ${server} (${result.is_demo ? "DEMO" : "REAL"}). Balance: ${result.balance?.toFixed(2)} ${result.currency ?? ""}`);
    return { ok: true, account: { id: account.id, label, login, server, isDemo: result.is_demo }, balance: result.balance, currency: result.currency };
  });

  /** Reconnect to a previously saved account using its stored credentials. */
  app.post("/api/mt5/accounts/:id/reconnect", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await prisma.mt5Account.findFirst({ where: { id, userId: req.user.id, archivedAt: null } });
    if (!account?.passwordEnc) return reply.code(404).send({ error: "account not found or has no stored credentials" });
    const { decryptSecret } = await import("../../lib/crypto.js");
    const result = await mt5.connect({ login: account.login, password: decryptSecret(account.passwordEnc), server: account.server }, req.user.email);
    if (!result.ok) return reply.code(502).send({ error: `MT5 login failed: ${result.error}` });
    invalidateAccountCache();
    return { ok: true, login: account.login, isDemo: result.is_demo, balance: result.balance };
  });

  /**
   * Remove a past account from account management without destroying its
   * trade history. Stored credentials are erased immediately. The account
   * currently selected in the terminal must be switched away from first.
   */
  app.delete("/api/mt5/accounts/:id", { preHandler: [app.requireRole("ADMIN")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await prisma.mt5Account.findFirst({
      where: { id, userId: req.user.id, archivedAt: null },
      select: { id: true, label: true, login: true, server: true },
    });
    if (!account) return reply.code(404).send({ error: "account not found" });

    const current = await mt5.accountInfo().catch(() => null);
    if (current && String(current.login) === account.login) {
      return reply.code(409).send({ error: "Switch the MT5 terminal to another account before removing the active account." });
    }

    await prisma.mt5Account.update({
      where: { id: account.id },
      data: { archivedAt: new Date(), passwordEnc: null, verified: false },
    });
    invalidateAccountCache();
    await audit({
      actor: req.user.email,
      userId: req.user.id,
      category: "mt5",
      action: "account_removed",
      detail: { accountId: account.id, label: account.label, login: account.login, server: account.server },
    });
    return { ok: true };
  });
}
