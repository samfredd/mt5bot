import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { mt5, type AccountInfo } from "./client.js";

/**
 * Resolves the MT5 account the terminal is connected to RIGHT NOW to the
 * user's saved Mt5Account row, so every trade can be stamped with the
 * account it was placed on and history stays separated per account.
 *
 * Accounts the user logged into directly in the MT5 terminal (never via the
 * dashboard) are auto-registered on first sight — without that, their trades
 * could not be attributed and "history per account" would silently not apply.
 */

const TTL_MS = 10_000;
const cache = new Map<string, { id: string | null; ts: number }>();

/** Saved-account id for a known login, cached briefly per user+login. */
export async function accountIdForLogin(userId: string, login: string | number, info?: AccountInfo): Promise<string | null> {
  const key = `${userId}:${login}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.id;

  let account = await prisma.mt5Account.findFirst({
    where: { userId, login: String(login) },
    select: { id: true, archivedAt: true },
  });
  // An account removed from the saved list can still be selected directly in
  // MT5. If the terminal reports it as current again, restore it to the list
  // automatically so the UI and trade attribution match the terminal.
  if (account?.archivedAt) {
    account = await prisma.mt5Account.update({
      where: { id: account.id },
      data: { archivedAt: null },
      select: { id: true, archivedAt: true },
    });
  }
  if (!account && info) account = await register(userId, info);

  cache.set(key, { id: account?.id ?? null, ts: Date.now() });
  return account?.id ?? null;
}

/**
 * Saved-account id for whatever the terminal is connected to, or null when
 * the bridge is down. Callers must treat null as "account unknown" and fall
 * back to unscoped behavior.
 */
export async function currentAccountId(userId: string): Promise<string | null> {
  const info = await mt5.accountInfo().catch(() => null);
  if (!info) return null;
  return accountIdForLogin(userId, info.login, info);
}

/**
 * First sighting of a login the user never saved: register it (unverified —
 * auto-registration must not satisfy the live-account verification gate).
 * If it is the user's FIRST account, adopt their unstamped legacy trades:
 * with only one account known, they can only have been placed on it.
 *
 * Race-safe: two concurrent cache-miss calls for the same login both reach
 * here, but the (userId, login) unique index lets only one INSERT win. The
 * loser catches the P2002 unique violation and returns the winner's row, so a
 * single login can never split across two duplicate Mt5Account rows (which
 * would defeat the accountId-scoped one-position-per-pair guard). Legacy-trade
 * adoption runs ONLY on the path that actually created the row.
 */
async function register(userId: string, info: AccountInfo) {
  const login = String(info.login);
  try {
    const isFirst = (await prisma.mt5Account.count({ where: { userId } })) === 0;
    const account = await prisma.mt5Account.create({
      data: {
        userId, login, label: `Account ${login}`,
        server: info.server ?? "", isDemo: info.is_demo, verified: false,
      },
      select: { id: true, archivedAt: true },
    });
    if (isFirst) {
      await prisma.trade.updateMany({ where: { userId, accountId: null }, data: { accountId: account.id } });
    }
    await audit({
      actor: "system", userId, category: "mt5", action: "account_auto_registered",
      detail: { login, server: info.server ?? null, isDemo: info.is_demo, adoptedLegacyTrades: isFirst },
    });
    return account;
  } catch (err) {
    // Lost the create race: a concurrent call already inserted this login.
    // Return its row instead of leaving a duplicate; no adoption (the winner
    // already ran it).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.mt5Account.findFirst({ where: { userId, login }, select: { id: true, archivedAt: true } });
      if (existing) return existing;
    }
    throw err;
  }
}

/** Call after switching accounts so stale login→id mappings don't linger. */
export function invalidateAccountCache() {
  cache.clear();
}
