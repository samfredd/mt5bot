import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { config } from "../../config.js";

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
 * When REQUIRE_2FA=false (user opt-out), the gate always passes.
 */
export async function requireTwoFactor(userId: string, token: string | undefined): Promise<boolean> {
  if (!config.REQUIRE_2FA) return true;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.totpEnabled || !user.totpSecret) return false;
  if (!token) return false;
  return verifyTotp(user.totpSecret, token);
}
