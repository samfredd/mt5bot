import { prisma } from "../../lib/prisma.js";
import { logError } from "../../lib/audit.js";
import { reportIncident, resolveIncidentByDedupeKey } from "../incidents/service.js";
import { fetchSource } from "./adapters.js";
import { ensureSourceCatalogue } from "./catalogue.js";
import { applyRetention, ingestNormalized } from "./pipeline.js";
import { reviewPendingKnowledge } from "./approval.js";
import { getOperationalConfig } from "../system/operational-config.js";

const bucket = (date: Date, minutes: number) => Math.floor(date.getTime() / (minutes * 60_000));
export const ingestionKey = (slug: string, date: Date, minutes: number) => `${slug}:${bucket(date, Math.max(1, minutes))}`;
export function calculateReliability(base: number, confirmedFraction: number, unsafeFraction: number, official = false): number {
  if (official) return 0.98;
  return Number(Math.max(0.05, Math.min(0.95, base * 0.7 + confirmedFraction * 0.35 - unsafeFraction * 0.25)).toFixed(3));
}

export async function runSource(sourceId: string, now = new Date()) {
  const source = await prisma.intelligenceSource.findUniqueOrThrow({ where: { id: sourceId } });
  const idempotencyKey = ingestionKey(source.slug, now, source.pollIntervalMin);
  const existing = await prisma.intelligenceIngestionRun.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;
  const run = await prisma.intelligenceIngestionRun.create({ data: { sourceId, jobType: source.category, idempotencyKey } });
  try {
    const fetched = await fetchSource(source);
    const counts = await ingestNormalized(source.id, fetched.items);
    const nextFetchAt = new Date(now.getTime() + source.pollIntervalMin * 60_000);
    await prisma.intelligenceSource.update({ where: { id: source.id }, data: { healthStatus: "HEALTHY", consecutiveFailures: 0, lastFetchedAt: now, nextFetchAt, lastError: null, rateLimitRemaining: fetched.remaining } });
    await prisma.intelligenceIngestionRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", fetchedCount: counts.fetched, storedCount: counts.stored, duplicateCount: counts.duplicates, rateLimit: fetched.remaining === undefined ? {} : { remaining: fetched.remaining }, completedAt: new Date() } });
    await resolveIncidentByDedupeKey(`intelligence:${source.slug}`, "system").catch(() => undefined);
    return { ...run, status: "SUCCEEDED", ...counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failures = source.consecutiveFailures + 1;
    const backoffMin = Math.min(source.pollIntervalMin * 2 ** Math.min(failures, 5), 24 * 60);
    await prisma.intelligenceSource.update({ where: { id: source.id }, data: { healthStatus: failures >= 3 ? "FAILED" : "DEGRADED", consecutiveFailures: failures, lastError: message.slice(0, 1000), nextFetchAt: new Date(now.getTime() + backoffMin * 60_000) } });
    await prisma.intelligenceIngestionRun.update({ where: { id: run.id }, data: { status: "FAILED", errorCount: 1, error: message.slice(0, 2000), completedAt: new Date() } });
    await logError("intelligence", "source ingestion failed", { source: source.slug, error: message, backoffMin });
    if (failures >= 3) await reportIncident({ dedupeKey: `intelligence:${source.slug}`, severity: "WARNING", source: "intelligence", title: `${source.name} ingestion failing`, message: `${failures} consecutive failures. Next retry uses backoff.`, context: { error: message, backoffMin }, minIntervalMs: 60 * 60_000 });
    return { ...run, status: "FAILED", error: message };
  }
}

export async function runDueSources(now = new Date()) {
  await ensureSourceCatalogue();
  const due = await prisma.intelligenceSource.findMany({ where: { enabled: true, approved: true, OR: [{ nextFetchAt: null }, { nextFetchAt: { lte: now } }] }, orderBy: { reliabilityScore: "desc" }, take: 30 });
  const results = [];
  for (const source of due) results.push(await runSource(source.id, now));
  await reviewPendingKnowledge().catch((error) => logError("intelligence-approval", "automatic knowledge review failed", { error: String(error) }));
  return results;
}

export async function intelligenceMaintenance(now = new Date()) {
  const retention = await applyRetention(now);
  const sources = await prisma.intelligenceSource.findMany({ select: { id: true, baseReliability: true, official: true } });
  for (const source of sources) {
    const items = await prisma.intelligenceItem.findMany({ where: { sourceId: source.id, publishedAt: { gte: new Date(now.getTime() - 30 * 86400_000) } }, select: { verificationStatus: true, promptInjectionDetected: true } });
    if (!items.length) continue;
    const confirmed = items.filter((item) => ["CONFIRMED", "OFFICIAL"].includes(item.verificationStatus)).length / items.length;
    const unsafe = items.filter((item) => item.promptInjectionDetected).length / items.length;
    const score = calculateReliability(source.baseReliability, confirmed, unsafe, source.official);
    await prisma.intelligenceSource.update({ where: { id: source.id }, data: { reliabilityScore: score } });
  }
  await reviewPendingKnowledge(50).catch((error) => logError("intelligence-approval", "maintenance knowledge review failed", { error: String(error) }));
  return retention;
}

export async function intelligenceDashboard() {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [sources, latest, stories, pending, conflicts, reviewed, runs, briefs, counts, config] = await Promise.all([
    prisma.intelligenceSource.findMany({ orderBy: [{ enabled: "desc" }, { reliabilityScore: "desc" }] }),
    prisma.intelligenceItem.findMany({ where: { archivedAt: null }, orderBy: [{ relevanceScore: "desc" }, { publishedAt: "desc" }], take: 60, include: { source: { select: { name: true, slug: true, official: true } }, story: { select: { verificationStatus: true, sourceCount: true } } } }),
    prisma.intelligenceStory.findMany({ where: { lastSeenAt: { gte: since } }, orderBy: [{ sourceCount: "desc" }, { lastSeenAt: "desc" }], take: 20 }),
    prisma.knowledgeEntry.findMany({ where: { status: "PENDING" }, orderBy: { updatedAt: "desc" }, take: 30 }),
    prisma.knowledgeEntry.findMany({ where: { status: "CONFLICTED" }, orderBy: { updatedAt: "desc" }, take: 20 }),
    prisma.knowledgeEntry.findMany({ where: { status: { in: ["APPROVED", "REJECTED"] }, approvalMethod: { not: null } }, orderBy: { approvedAt: "desc" }, take: 30 }),
    prisma.intelligenceIngestionRun.findMany({ orderBy: { startedAt: "desc" }, take: 50, include: { source: { select: { name: true } } } }),
    prisma.researchBrief.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    Promise.all([prisma.intelligenceItem.count(), prisma.knowledgeEntry.count(), prisma.intelligenceItem.count({ where: { promptInjectionDetected: true } })]),
    getOperationalConfig(),
  ]);
  return { generatedAt: new Date().toISOString(), approval: { mode: config.intelligenceApprovalMode, minConfidence: config.intelligenceAiApprovalMinConfidence }, sources, latest, trending: stories, pendingKnowledge: pending, conflicts, reviewedKnowledge: reviewed, runs, briefs, storage: { items: counts[0], knowledge: counts[1], quarantined: counts[2] } };
}

export async function searchIntelligence(query: string, limit = 20) {
  const tsQuery = buildSearchTsQuery(query);
  if (!tsQuery) return [];
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT i.*, s.name AS "sourceName", ts_rank(to_tsvector('english', i."searchText"), to_tsquery('english', $1)) AS rank FROM "IntelligenceItem" i JOIN "IntelligenceSource" s ON s.id=i."sourceId" WHERE i."archivedAt" IS NULL AND to_tsvector('english', i."searchText") @@ to_tsquery('english', $1) ORDER BY rank DESC, i."relevanceScore" DESC LIMIT $2`, tsQuery, limit);
  return rows;
}

const SEARCH_STOP_WORDS = new Set(["about", "affecting", "and", "are", "conclusion", "current", "discussing", "give", "information", "latest", "major", "market", "news", "now", "please", "show", "sources", "summarise", "summarize", "supporting", "today", "traders", "what", "which", "with"]);
export function buildSearchTsQuery(query: string): string {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
    .filter((token) => !SEARCH_STOP_WORDS.has(token))
    .slice(0, 12)
    .join(" | ");
}
