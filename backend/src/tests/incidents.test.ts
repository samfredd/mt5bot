import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  incidents: [] as Record<string, unknown>[],
  broadcasts: [] as { event: string; payload: unknown }[],
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    incident: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        h.incidents.find((incident) =>
          incident.dedupeKey === where.dedupeKey && incident.status !== "RESOLVED",
        ) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const incident = {
          id: `i${h.incidents.length + 1}`,
          occurrenceCount: 1,
          status: "OPEN",
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          ...data,
        };
        h.incidents.push(incident);
        return incident;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const incident = h.incidents.find((item) => item.id === where.id);
        if (!incident) throw new Error("not found");
        for (const [key, value] of Object.entries(data)) {
          if (key === "occurrenceCount" && typeof value === "object" && value && "increment" in value) {
            incident.occurrenceCount = Number(incident.occurrenceCount ?? 0) + Number(value.increment);
          } else {
            incident[key] = value;
          }
        }
        return incident;
      }),
      findMany: vi.fn(async (args: { where?: { status?: string | { not?: string } }; take?: number } = {}) => {
        let rows = h.incidents;
        const status = args.where?.status;
        if (typeof status === "string") rows = rows.filter((incident) => incident.status === status);
        else if (status?.not) rows = rows.filter((incident) => incident.status !== status.not);
        return rows.slice(0, args.take);
      }),
    },
  },
}));

vi.mock("../modules/ws/hub.js", () => ({
  broadcast: vi.fn((event: string, payload: unknown) => h.broadcasts.push({ event, payload })),
}));

const { acknowledgeIncident, listIncidents, reportIncident, resolveIncident, resolveIncidentByDedupeKey } = await import("../modules/incidents/service.js");

beforeEach(() => {
  h.incidents = [];
  h.broadcasts = [];
});

describe("incident service", () => {
  it("aggregates repeated active incidents by dedupe key", async () => {
    const first = await reportIncident({
      dedupeKey: "mt5:circuit-open",
      severity: "CRITICAL",
      source: "mt5",
      title: "MT5 unavailable",
      message: "Bridge circuit opened",
      context: { attempt: 1 },
    });
    const second = await reportIncident({
      dedupeKey: "mt5:circuit-open",
      severity: "CRITICAL",
      source: "mt5",
      title: "MT5 unavailable",
      message: "Bridge circuit opened again",
      context: { attempt: 2 },
    });

    expect(second.id).toBe(first.id);
    expect(second.occurrenceCount).toBe(2);
    expect(second.message).toBe("Bridge circuit opened again");
    expect(h.incidents).toHaveLength(1);
    expect(h.broadcasts).toHaveLength(2);
  });

  it("throttles repeated active incidents when requested", async () => {
    const first = await reportIncident({
      dedupeKey: "mt5:circuit-open",
      severity: "CRITICAL",
      source: "mt5",
      title: "MT5 unavailable",
      message: "Bridge circuit opened",
      minIntervalMs: 60_000,
    });
    const second = await reportIncident({
      dedupeKey: "mt5:circuit-open",
      severity: "CRITICAL",
      source: "mt5",
      title: "MT5 unavailable",
      message: "Bridge circuit still open",
      minIntervalMs: 60_000,
    });

    expect(second.id).toBe(first.id);
    expect(second.occurrenceCount).toBe(1);
    expect(second.message).toBe("Bridge circuit opened");
    expect(h.broadcasts).toHaveLength(1);
  });

  it("acknowledges and resolves an incident with actor metadata", async () => {
    const incident = await reportIncident({
      dedupeKey: "redis:down",
      severity: "WARNING",
      source: "redis",
      title: "Redis unavailable",
      message: "Trading is fail-closed",
    });

    const acknowledged = await acknowledgeIncident(incident.id, "admin@example.com");
    expect(acknowledged).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedBy: "admin@example.com" });
    expect(acknowledged.acknowledgedAt).toBeInstanceOf(Date);

    const resolved = await resolveIncident(incident.id, "admin@example.com");
    expect(resolved).toMatchObject({ status: "RESOLVED", resolvedBy: "admin@example.com" });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
  });

  it("lists incidents through the durable store", async () => {
    await reportIncident({
      dedupeKey: "scheduler:analysis",
      severity: "WARNING",
      source: "scheduler",
      title: "Analysis failed",
      message: "tick failed",
    });

    await expect(listIncidents({ status: "OPEN", limit: 25 })).resolves.toHaveLength(1);
  });

  it("defaults to active incidents and hides resolved history", async () => {
    const old = await reportIncident({
      dedupeKey: "redis:startup-unavailable",
      severity: "CRITICAL",
      source: "redis",
      title: "Redis unavailable",
      message: "Startup failed closed",
    });
    await resolveIncident(old.id, "system");
    await reportIncident({
      dedupeKey: "news:circuit-open",
      severity: "WARNING",
      source: "news",
      title: "News circuit open",
      message: "Calendar is rate limited",
    });

    const active = await listIncidents({ limit: 25 });

    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ dedupeKey: "news:circuit-open", status: "OPEN" });
  });

  it("resolves an active incident by dedupe key", async () => {
    await reportIncident({
      dedupeKey: "redis:startup-unavailable",
      severity: "CRITICAL",
      source: "redis",
      title: "Redis unavailable",
      message: "Startup failed closed",
    });

    const resolved = await resolveIncidentByDedupeKey("redis:startup-unavailable", "system");

    expect(resolved).toMatchObject({ status: "RESOLVED", resolvedBy: "system" });
    expect(h.broadcasts.at(-1)?.payload).toMatchObject({ status: "RESOLVED" });
  });
});
