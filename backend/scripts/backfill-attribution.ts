/**
 * One-time profit-attribution backfill.
 *
 * Re-runs broker reconciliation against the live bridge to fill in P/L for
 * trades that were closed but stored with profit=null (attributionReason
 * "deal_history_missing") — typically because the bridge's deal history was
 * stale/empty at the time. syncClosedTrades already re-attributes any CLOSED,
 * profit-null trade within the last 7 days, so this simply triggers that path
 * immediately instead of waiting for the 60s scheduler.
 *
 * Read-only against the broker (only queries deal history); writes profit to
 * the DB. Never places or closes trades.
 *
 *   npx tsx scripts/backfill-attribution.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { mt5 } from "../src/modules/mt5/client.js";
import { syncClosedTrades } from "../src/modules/trading/reconciliation.js";
import { SCALPING_SOURCE } from "../src/modules/scalping/scalping.types.js";

const SCALP = { path: ["source"], equals: SCALPING_SOURCE } as const;

async function countUnattributed(): Promise<{ all: number; scalp: number }> {
  const [all, scalp] = await Promise.all([
    prisma.trade.count({ where: { status: "CLOSED", profit: null, mt5Ticket: { not: null } } }),
    prisma.trade.count({ where: { status: "CLOSED", profit: null, mt5Ticket: { not: null }, explanation: SCALP } }),
  ]);
  return { all, scalp };
}

const before = await countUnattributed();
console.log(`\n=== ATTRIBUTION BACKFILL ===`);
console.log(`unattributed CLOSED trades (profit=null) — before: ${before.all} total, ${before.scalp} scalp`);

// Show what the bridge is actually returning so a still-empty feed is obvious.
try {
  const deals = await mt5.history(7);
  const maxTime = deals.reduce<string | null>((m, d) => (d.time && (!m || d.time > m) ? d.time : m), null);
  console.log(`bridge /history(7d): ${deals.length} deals, latest ${maxTime ?? "none"}`);
  if (deals.length === 0) {
    console.warn("⚠  bridge returned 0 deals — backfill cannot attribute anything. Fix the bridge first.");
  }
} catch (err) {
  console.error(`✗ bridge history call failed: ${String(err)}`);
}

await syncClosedTrades();

const after = await countUnattributed();
console.log(`unattributed CLOSED trades (profit=null) — after:  ${after.all} total, ${after.scalp} scalp`);
console.log(`attributed this run: ${before.all - after.all} total, ${before.scalp - after.scalp} scalp\n`);

await prisma.$disconnect();
