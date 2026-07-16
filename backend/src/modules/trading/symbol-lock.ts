import { prisma } from "../../lib/prisma.js";

/**
 * Cross-strategy one-position-per-pair guard.
 *
 * With overlapping strategies (e.g. two ALL_FX presets), the same pair can be
 * evaluated by several strategies on the same tick. Left unchecked they would
 * stack (double exposure) or — worse, on a netting account — open opposite
 * sides that offset, bleeding spread + commission for ~zero net position.
 *
 * This guard lets the FIRST owner (any strategy, or a manual/scanner trade with
 * no strategyId) hold the pair, and makes every other entry stand aside until
 * that position is closed. This includes same-strategy re-entry because MT5
 * netting accounts would merge the fills and destroy per-trade attribution.
 */

/** Statuses that mean a trade is occupying the market (live fill or pending fill). */
export const OCCUPYING_STATUSES = ["SUBMITTING", "PARTIALLY_FILLED", "UNKNOWN", "EXECUTED", "PENDING_APPROVAL", "APPROVED"] as const;

/**
 * Stable identity for "the same market", tolerant of broker suffixes/separators.
 * EURUSD, EURUSDm and EURUSD.r all map to "EURUSD"; US30 and NAS100 stay
 * distinct. Pure — no broker lookup.
 */
export function marketKey(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[._\-/].*$/, "");
  const core6 = s.slice(0, 6);
  return /^[A-Z]{6}$/.test(core6) ? core6 : s;
}

/**
 * Pure: among live/pending trades, find one on the same market owned by a
 * any owner. One canonical market has one owner at a time, which is required
 * for correct attribution on MT5 netting accounts.
 */
export function conflictingTrade<T extends { symbol: string; strategyId: string | null }>(
  live: T[],
  symbol: string,
  _strategyId: string,
): T | null {
  const key = marketKey(symbol);
  return live.find((t) => marketKey(t.symbol) === key) ?? null;
}

/**
 * Impure: is this pair already held by another owner for this user, ON THE
 * ACCOUNT THE TERMINAL IS CONNECTED TO RIGHT NOW? Looks at the user's small set
 * of occupying trades and applies {@link conflictingTrade}.
 *
 * The `accountId` scope mirrors reconciliation (see syncClosedTrades): only
 * trades on the current account (or legacy unstamped ones) can occupy the pair.
 * Without it, an EXECUTED trade orphaned on a previous/defunct account becomes a
 * zombie that reconciliation can NEVER close (it only sees the current account)
 * yet permanently blocks this account from trading that pair. When `accountId`
 * is null (bridge down → account unknown) we fall back to unscoped, matching the
 * "treat null as account unknown" contract; evaluation fails later anyway.
 */
export async function symbolHeldByOther(
  userId: string,
  symbol: string,
  strategyId: string,
  accountId: string | null,
): Promise<{ id: string; symbol: string; strategyId: string | null; direction: string } | null> {
  const accountScope = accountId ? { OR: [{ accountId: null }, { accountId }] } : {};
  const live = await prisma.trade.findMany({
    where: { userId, status: { in: [...OCCUPYING_STATUSES] }, ...accountScope },
    select: { id: true, symbol: true, strategyId: true, direction: true },
  });
  return conflictingTrade(live, symbol, strategyId);
}
