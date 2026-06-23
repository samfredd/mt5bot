import { logger } from "../../lib/logger.js";
import { audit, logError } from "../../lib/audit.js";
import { withSchedulerLease } from "../../workers/scheduler-lease.js";
import { getScalpingConfig } from "./scalping.state.js";
import { refreshStalePlans } from "./scalping.ai.js";
import { attemptScalpEntries, manageOpenScalps } from "./scalping.service.js";

/**
 * Scalping runs on its OWN cadence, fully separate from the 60-second strategy/
 * scanner scheduler:
 *
 *  - fireTimer (1s): close positions hitting money targets (always), and — only
 *    while running, under a Redis lease — attempt new entries using CACHED AI
 *    decisions. The AI is never called here.
 *  - aiTimer (~ttl/4): refresh any expired per-symbol AI/technical plans, so the
 *    1s loop always reads a recent decision instead of calling the model.
 *
 * Single-writer safety: the entry path is wrapped in `withSchedulerLease` so
 * multiple backend processes cannot double-open. Protective closing runs without
 * the lease (closing an already-open position is idempotent and must not depend
 * on lease acquisition). Entries also fail closed when Redis is unavailable.
 */

const FIRE_INTERVAL_MS = 1_000;
const ENTRY_LEASE_MS = 5_000;
const BLOCK_AUDIT_THROTTLE_MS = 30_000;

let fireTimer: NodeJS.Timeout | null = null;
let aiTimer: NodeJS.Timeout | null = null;
let firing = false;
let refreshing = false;

type ScalpEntryAttemptResult = Awaited<ReturnType<typeof attemptScalpEntries>>;

export interface ScalpBlockAuditState {
  signature: string;
  at: number;
}

export function maybeScalpingBlockAudit(
  result: ScalpEntryAttemptResult,
  previous: ScalpBlockAuditState | null,
  now = Date.now(),
  throttleMs = BLOCK_AUDIT_THROTTLE_MS,
): { event: { detail: Record<string, unknown> } | null; state: ScalpBlockAuditState | null } {
  if (result.opened.length > 0 || result.blocked.length === 0) {
    return { event: null, state: previous };
  }

  const blocked = result.blocked.slice(0, 5);
  const signature = blocked.map((b) => `${b.symbol}:${b.reason}`).join("|");
  if (previous && previous.signature === signature && now - previous.at < throttleMs) {
    return { event: null, state: previous };
  }

  const first = blocked[0];
  return {
    event: {
      detail: {
        symbol: first?.symbol ?? "*",
        reason: first?.reason ?? "unknown block",
        blockedCount: result.blocked.length,
        skipped: result.skipped,
        blocked,
      },
    },
    state: { signature, at: now },
  };
}

let lastBlockAudit: ScalpBlockAuditState | null = null;

async function fireTick(): Promise<void> {
  if (firing) return; // a slow bridge tick must not overlap itself
  firing = true;
  try {
    // Protective exits run every second regardless of run-state.
    await manageOpenScalps().catch((err) => logError("scalping-worker", "exit management failed", { error: String(err) }));

    const config = await getScalpingConfig();
    if (config.status !== "running" || !config.enabled) return;

    // New entries: single-writer via Redis lease; null = another process holds it.
    const result = await withSchedulerLease("scalping-entries", ENTRY_LEASE_MS, () => attemptScalpEntries("scalping:auto"))
      .catch((err) => logError("scalping-worker", "entry attempt failed", { error: String(err) }));
    if (!result) return;

    const nextAudit = maybeScalpingBlockAudit(result, lastBlockAudit);
    lastBlockAudit = nextAudit.state;
    if (nextAudit.event) {
      await audit({
        actor: "scalping:auto",
        category: "risk",
        action: "scalp_entry_blocked",
        detail: nextAudit.event.detail,
      });
    }
  } catch (err) {
    await logError("scalping-worker", "fire tick failed", { error: String(err) });
  } finally {
    firing = false;
  }
}

async function aiTick(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const config = await getScalpingConfig();
    if (config.status !== "running" || !config.enabled) return;
    await refreshStalePlans(config);
  } catch (err) {
    await logError("scalping-worker", "ai refresh failed", { error: String(err) });
  } finally {
    refreshing = false;
  }
}

export function startScalpingWorker(): void {
  if (fireTimer || aiTimer) return;
  fireTimer = setInterval(() => void fireTick(), FIRE_INTERVAL_MS);
  fireTimer.unref?.();
  // Refresh stale plans a few times per TTL window; refreshStalePlans no-ops on
  // still-fresh plans, so a short interval is cheap. Default TTL 60s → ~15s.
  aiTimer = setInterval(() => void aiTick(), 15_000);
  aiTimer.unref?.();
  logger.info("scalping worker started (1s fire loop + AI refresh cadence)");
}

export function stopScalpingWorker(): void {
  if (fireTimer) clearInterval(fireTimer);
  if (aiTimer) clearInterval(aiTimer);
  fireTimer = null;
  aiTimer = null;
}
