import { prisma } from "../../lib/prisma.js";
import { broadcast } from "../ws/hub.js";

export type IncidentSeverity = "INFO" | "WARNING" | "CRITICAL";
export type IncidentStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
export type IncidentListStatus = IncidentStatus | "ACTIVE" | "ALL";

export interface IncidentInput {
  dedupeKey: string;
  severity: IncidentSeverity;
  source: string;
  title: string;
  message: string;
  context?: Record<string, unknown>;
  minIntervalMs?: number;
}

function timestampMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export async function reportIncident(input: IncidentInput) {
  const active = await prisma.incident.findFirst({
    where: { dedupeKey: input.dedupeKey, status: { not: "RESOLVED" } },
    orderBy: { lastSeenAt: "desc" },
  });
  const now = new Date();
  if (active && input.minIntervalMs && now.getTime() - timestampMs(active.lastSeenAt) < input.minIntervalMs) {
    return active;
  }
  const incident = active
    ? await prisma.incident.update({
      where: { id: active.id },
      data: {
        severity: input.severity,
        source: input.source,
        title: input.title,
        message: input.message,
        context: (input.context ?? {}) as object,
        occurrenceCount: { increment: 1 },
        lastSeenAt: now,
      },
    })
    : await prisma.incident.create({
      data: {
        dedupeKey: input.dedupeKey,
        severity: input.severity,
        source: input.source,
        title: input.title,
        message: input.message,
        context: (input.context ?? {}) as object,
      },
    });
  broadcast("incident", incident);
  return incident;
}

function incidentWhere(status: IncidentListStatus | undefined) {
  if (status === "ALL") return undefined;
  if (status === "ACTIVE" || status === undefined) return { status: { not: "RESOLVED" as const } };
  return { status };
}

export async function listIncidents(options: { status?: IncidentListStatus; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const incidents = await prisma.incident.findMany({
    where: incidentWhere(options.status),
    orderBy: { lastSeenAt: "desc" },
    take: options.status === "RESOLVED" || options.status === "ALL" ? limit : Math.min(limit * 5, 500),
  });
  if (options.status === "RESOLVED" || options.status === "ALL") return incidents;

  const seen = new Set<string>();
  const active = [];
  for (const incident of incidents) {
    if (seen.has(incident.dedupeKey)) continue;
    seen.add(incident.dedupeKey);
    active.push(incident);
    if (active.length >= limit) break;
  }
  return active;
}

export async function acknowledgeIncident(id: string, actor: string) {
  const incident = await prisma.incident.update({
    where: { id },
    data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedBy: actor },
  });
  broadcast("incident", incident);
  return incident;
}

export async function resolveIncident(id: string, actor: string) {
  const incident = await prisma.incident.update({
    where: { id },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: actor },
  });
  broadcast("incident", incident);
  return incident;
}

export async function resolveIncidentByDedupeKey(dedupeKey: string, actor: string) {
  const active = await prisma.incident.findFirst({
    where: { dedupeKey, status: { not: "RESOLVED" } },
    orderBy: { lastSeenAt: "desc" },
  });
  if (!active) return null;
  return resolveIncident(active.id, actor);
}
