import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { readJson, writeJson } from "../../lib/redis.js";

export async function registerUser(email: string, password: string) {
  const count = await prisma.user.count();
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(password, 12),
      // First registered user becomes admin; everyone else starts as viewer.
      role: count === 0 ? "ADMIN" : "VIEWER",
      riskSettings: { create: {} },
    },
  });
  await audit({ actor: email, userId: user.id, category: "auth", action: "user_registered" });
  return user;
}

export async function verifyLogin(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  await audit({
    actor: email,
    userId: user?.id,
    category: "auth",
    action: ok ? "login_success" : "login_failed",
  });
  return ok ? user : null;
}

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/**
 * Token revocation without a schema change: a per-user "valid after" epoch
 * (seconds). Logging out bumps it to now, instantly invalidating every JWT
 * issued earlier (its `iat` predates the cutoff). Persisted in SystemSetting
 * so it survives restarts; cached in-process to keep auth checks cheap.
 */
const revokedBefore = new Map<string, number>();
const revokeKey = (userId: string) => `token_revoked_before:${userId}`;
const redisRevokeKey = (userId: string) => `jwt:revoked:${userId}`;

export async function tokensValidAfter(userId: string): Promise<number> {
  const cached = revokedBefore.get(userId);
  if (cached !== undefined) return cached;
  const mirrored = await readJson<{ after: number }>(redisRevokeKey(userId));
  if (mirrored?.after !== undefined) {
    revokedBefore.set(userId, mirrored.after);
    return mirrored.after;
  }
  const row = await prisma.systemSetting.findUnique({ where: { key: revokeKey(userId) } });
  const v = Number((row?.value as { after?: number } | undefined)?.after ?? 0);
  revokedBefore.set(userId, v);
  await writeJson(redisRevokeKey(userId), { after: v });
  return v;
}

export async function revokeUserTokens(userId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  revokedBefore.set(userId, now);
  await prisma.systemSetting.upsert({
    where: { key: revokeKey(userId) },
    create: { key: revokeKey(userId), value: { after: now } },
    update: { value: { after: now } },
  });
  await writeJson(redisRevokeKey(userId), { after: now });
}

/** True when a token (by issued-at) was minted before the user's revoke cutoff. */
export async function isTokenRevoked(userId: string, iat: number | undefined): Promise<boolean> {
  if (!iat) return false;
  return iat < (await tokensValidAfter(userId));
}

export function verifyTotp(secret: string, token: string): boolean {
  try {
    return authenticator.verify({ secret, token });
  } catch {
    return false;
  }
}

/**
 * Gate for any live-trading action: user must have 2FA enabled and present
 * a fresh valid TOTP token. Demo-mode actions do not require this.
 * When live 2FA is switched off in Settings (bot_state.requireLiveTwoFactor),
 * the gate always passes.
 */
export async function requireTwoFactor(userId: string, token: string | undefined): Promise<boolean> {
  const { getBotState } = await import("../system/state.js");
  if (!(await getBotState()).requireLiveTwoFactor) return true;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.totpEnabled || !user.totpSecret) return false;
  if (!token) return false;
  return verifyTotp(user.totpSecret, token);
}
