import { prisma } from "./prisma.js";
import { logger } from "./logger.js";
import { broadcast } from "../modules/ws/hub.js";

export type AuditCategory =
  | "auth"
  | "trade"
  | "risk"
  | "strategy"
  | "news"
  | "ai"
  | "copy"
  | "telegram"
  | "whatsapp"
  | "system"
  | "mt5";

/** Every important action flows through here. Fire-and-forget safe. */
export async function audit(opts: {
  actor: string;
  category: AuditCategory;
  action: string;
  userId?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actor: opts.actor,
        category: opts.category,
        action: opts.action,
        userId: opts.userId,
        detail: (opts.detail ?? {}) as object,
      },
    });
    // Live activity feed for the dashboard.
    broadcast("audit", {
      actor: opts.actor,
      category: opts.category,
      action: opts.action,
      detail: opts.detail ?? {},
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, opts }, "failed to write audit log");
  }
}

export async function logError(source: string, message: string, detail?: Record<string, unknown>) {
  logger.error({ source, detail }, message);
  try {
    await prisma.errorLog.create({ data: { source, message, detail: (detail ?? {}) as object } });
  } catch {
    /* never throw from error logging */
  }
}
