import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { detectPromptInjection, sanitizeExternalText } from "./security.js";

export interface RawIntelligenceItem {
  externalId?: string;
  url?: string;
  title: string;
  author?: string;
  content?: string;
  publishedAt?: Date | null;
  kind?: string;
  engagement?: Record<string, number>;
  raw?: Record<string, unknown>;
}

const ASSETS = ["EUR", "USD", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "CNY", "XAU", "XAG", "BTC", "ETH", "OIL", "US30", "NAS100", "SPX"];
const ASSET_PATTERNS: Record<(typeof ASSETS)[number], RegExp> = {
  EUR: /\bEUR\b|\bEURO(?:ZONE)?\b|\bECB\b/,
  USD: /\bUSD\b|\bU\.?S\.? DOLLAR\b|\bDOLLAR\b|\bFED(?:ERAL RESERVE)?\b/,
  GBP: /\bGBP\b|\bBRITISH POUND\b|\bSTERLING\b|\bBOE\b/,
  JPY: /\bJPY\b|\bYEN\b|\bBOJ\b/,
  AUD: /\bAUD\b|\bAUSTRALIAN DOLLAR\b|\bRBA\b/,
  NZD: /\bNZD\b|\bNEW ZEALAND DOLLAR\b|\bRBNZ\b/,
  CAD: /\bCAD\b|\bCANADIAN DOLLAR\b|\bBOC\b/,
  CHF: /\bCHF\b|\bSWISS FRANC\b|\bSNB\b/,
  CNY: /\bCNY\b|\bYUAN\b|\bRENMINBI\b|\bPBOC\b/,
  XAU: /\bXAU(?:USD)?\b|\bGOLD\b/,
  XAG: /\bXAG(?:USD)?\b|\bSILVER\b/,
  BTC: /\bBTC\b|\bBITCOIN\b/,
  ETH: /\bETH\b|\bETHEREUM\b/,
  OIL: /\bOIL\b|\bCRUDE\b|\bOPEC\b/,
  US30: /\bUS30\b|\bDOW(?: JONES)?\b/,
  NAS100: /\bNAS100\b|\bNASDAQ(?: 100)?\b/,
  SPX: /\bSPX\b|\bS&P ?500\b/,
};
const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "from", "says", "after", "as", "at", "is", "are", "new", "latest", "no", "not", "never", "denies", "denied", "false"]);

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9%]+/g, " ").split(/\s+/).filter((word) => word.length > 2 && !STOP.has(word));
export const storyFingerprint = (title: string) => hash([...new Set(words(title))].sort().slice(0, 14).join(" "));
export const contentHash = (title: string, content: string) => hash(`${title.toLowerCase().trim()}|${content.toLowerCase().trim().slice(0, 4000)}`);
export function claimsContradict(left: string, right: string): boolean {
  const negated = (value: string) => /\b(no|not|never|denies|denied|false|won't|will not|rules out)\b/i.test(value);
  if (negated(left) === negated(right)) return false;
  const a = new Set(words(left).filter((word) => !["not", "never", "denies", "denied", "false"].includes(word)));
  const b = new Set(words(right).filter((word) => !["not", "never", "denies", "denied", "false"].includes(word)));
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / Math.max(1, Math.min(a.size, b.size)) >= 0.55;
}

export function featureEmbedding(text: string, dimensions = 64): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of words(text)) {
    const digest = createHash("sha256").update(token).digest();
    vector[digest.readUInt16BE(0) % dimensions] += digest[2] % 2 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

export function classifyMarketText(title: string, content: string) {
  const text = `${title} ${content}`.toUpperCase();
  const relatedAssets = ASSETS.filter((asset) => ASSET_PATTERNS[asset].test(text));
  const high = /RATE (HIKE|CUT|DECISION)|CENTRAL BANK|FEDERAL RESERVE|ECB|INFLATION|CPI|PAYROLL|EMPLOYMENT|WAR|INVASION|SANCTION|INTERVENTION|EMERGENCY|DEFAULT/.test(text);
  const topic = /RATE|FED|ECB|CENTRAL BANK|BOE|BOJ/.test(text) ? "CENTRAL_BANK" : /INFLATION|CPI|PCE/.test(text) ? "INFLATION" : /JOB|PAYROLL|EMPLOYMENT|UNEMPLOYMENT/.test(text) ? "EMPLOYMENT" : /WAR|CONFLICT|SANCTION|ELECTION/.test(text) ? "GEOPOLITICS" : /GOLD|OIL|COMMODIT/.test(text) ? "COMMODITIES" : /FOREX|CURRENCY|DOLLAR|EURO|YEN|POUND/.test(text) ? "FX" : "OTHER";
  const factuality = /OPINION|COMMENTARY|ANALYSIS|PREDICT|FORECAST/.test(text) ? "OPINION" : /RUMOU?R|UNCONFIRMED|REPORTEDLY/.test(text) ? "RUMOUR" : /SPONSORED|PROMOTED|AFFILIATE/.test(text) ? "PROMOTION" : "REPORT";
  return { relatedAssets, topic, factuality, expectedImpact: high ? "HIGH" : relatedAssets.length ? "MEDIUM" : "LOW", urgency: /BREAKING|JUST IN|EMERGENCY/.test(text) ? "BREAKING" : "NORMAL" };
}

function expiry(kind: string, factuality: string, publishedAt: Date | null): Date {
  const base = publishedAt?.getTime() ?? Date.now();
  const hours = kind === "COMMUNITY" ? 24 : factuality === "OPINION" || factuality === "RUMOUR" ? 48 : kind === "VIDEO" ? 24 * 180 : 24 * 14;
  return new Date(base + hours * 3600_000);
}

export async function ingestNormalized(sourceId: string, raws: RawIntelligenceItem[]) {
  const source = await prisma.intelligenceSource.findUniqueOrThrow({ where: { id: sourceId } });
  const positions = await mt5.positions().catch(() => []);
  const activeSymbols = new Set(positions.map((position) => position.symbol.toUpperCase()));
  let stored = 0; let duplicates = 0;
  for (const raw of raws) {
    const title = sanitizeExternalText(raw.title, 500);
    const content = sanitizeExternalText(raw.content ?? raw.title);
    if (!title) continue;
    const cHash = contentHash(title, content);
    if (await prisma.intelligenceItem.findUnique({ where: { sourceId_contentHash: { sourceId, contentHash: cHash } }, select: { id: true } })) { duplicates++; continue; }
    const classification = classifyMarketText(title, content);
    const fingerprint = storyFingerprint(title);
    const existingStory = await prisma.intelligenceStory.findUnique({ where: { fingerprint }, include: { items: { select: { sourceId: true } } } });
    const distinctSources = new Set([...(existingStory?.items.map((item) => item.sourceId) ?? []), sourceId]);
    const confirmationCount = distinctSources.size;
    const priorTitles = existingStory ? await prisma.intelligenceItem.findMany({ where: { storyId: existingStory.id }, select: { title: true }, take: 20 }) : [];
    const contradicted = priorTitles.some((prior) => claimsContradict(prior.title, title));
    const verificationStatus = contradicted ? "CONFLICTED" : source.official ? "OFFICIAL" : confirmationCount >= 2 ? "CONFIRMED" : classification.factuality === "RUMOUR" ? "RUMOUR" : "UNCONFIRMED";
    const openPositionMatch = classification.relatedAssets.some((asset) => [...activeSymbols].some((symbol) => symbol.includes(asset)));
    const recency = raw.publishedAt ? Math.max(0, 1 - (Date.now() - raw.publishedAt.getTime()) / (24 * 3600_000)) : 0.25;
    const credibility = Math.max(0, Math.min(1, source.reliabilityScore * (verificationStatus === "CONFIRMED" || verificationStatus === "OFFICIAL" ? 1 : 0.75)));
    const impact = classification.expectedImpact === "HIGH" ? 1 : classification.expectedImpact === "MEDIUM" ? 0.6 : 0.2;
    const relevanceScore = Number(Math.min(1, credibility * 0.25 + recency * 0.2 + impact * 0.25 + (openPositionMatch ? 0.25 : 0) + (confirmationCount > 1 ? 0.05 : 0)).toFixed(3));
    const story = await prisma.intelligenceStory.upsert({
      where: { fingerprint },
      create: { fingerprint, title, topic: classification.topic, verificationStatus, confirmationCount, sourceCount: confirmationCount, relatedAssets: classification.relatedAssets, firstSeenAt: raw.publishedAt ?? new Date(), lastSeenAt: raw.publishedAt ?? new Date() },
      update: { lastSeenAt: raw.publishedAt ?? new Date(), verificationStatus, confirmationCount, sourceCount: confirmationCount, relatedAssets: classification.relatedAssets },
    });
    const injection = detectPromptInjection(`${title}\n${content}`);
    const item = await prisma.intelligenceItem.create({ data: {
      sourceId, storyId: story.id, externalId: raw.externalId, canonicalUrl: raw.url, title, author: raw.author, content,
      kind: raw.kind ?? source.category, topic: classification.topic, factuality: classification.factuality, verificationStatus,
      urgency: classification.urgency, expectedImpact: classification.expectedImpact, credibilityScore: credibility, relevanceScore,
      noveltyScore: existingStory ? 0.25 : 1, communityMomentum: raw.engagement ? Math.min(1, Math.log10(1 + Object.values(raw.engagement).reduce((a, b) => a + b, 0)) / 5) : 0,
      promptInjectionDetected: injection, relatedAssets: classification.relatedAssets, claims: [title], engagement: (raw.engagement ?? {}) as object, raw: (raw.raw ?? {}) as object,
      contentHash: cHash, searchText: `${title} ${content}`, embedding: featureEmbedding(`${title} ${content}`), publishedAt: raw.publishedAt ?? null,
      expiresAt: expiry(raw.kind ?? source.category, classification.factuality, raw.publishedAt ?? null),
    } });
    await prisma.intelligenceClaim.create({ data: { storyId: story.id, itemId: item.id, claimHash: hash(title.toLowerCase()), text: title, stance: contradicted ? "CONTRADICTS" : "SUPPORTS", verificationStatus, confidence: contradicted ? Math.min(credibility, 0.5) : credibility } });
    if (!injection && relevanceScore >= 0.65 && (verificationStatus === "CONFIRMED" || verificationStatus === "OFFICIAL")) {
      const key = `intel:${story.fingerprint}`;
      const provenance = [{ itemId: item.id, source: source.name, url: raw.url, publishedAt: raw.publishedAt?.toISOString() ?? null, retrievedAt: new Date().toISOString() }];
      const priorKnowledge = await prisma.knowledgeEntry.findUnique({ where: { key }, select: { status: true, provenance: true } });
      const priorProvenance = Array.isArray(priorKnowledge?.provenance) ? priorKnowledge.provenance as Array<{ itemId?: string }> : [];
      const mergedProvenance = [...priorProvenance, ...provenance].filter((entry, index, all) => entry.itemId && all.findIndex((candidate) => candidate.itemId === entry.itemId) === index);
      const pendingReset = priorKnowledge?.status === "PENDING" ? { approvalMethod: null, approvalDecision: null, approvalReason: null, approvalConfidence: null, approvedBy: null, approvedAt: null, reviewAt: new Date() } : {};
      const knowledge = await prisma.knowledgeEntry.upsert({ where: { key }, create: { key, type: "MARKET_EVENT", title, content, confidence: credibility, verificationStatus, status: "PENDING", provenance: mergedProvenance, relatedAssets: classification.relatedAssets, embedding: featureEmbedding(`${title} ${content}`), expiresAt: expiry("NEWS", classification.factuality, raw.publishedAt ?? null), reviewAt: new Date() }, update: { confidence: credibility, verificationStatus, provenance: mergedProvenance, currentVersion: { increment: 1 }, lastValidatedAt: new Date(), ...pendingReset } });
      await prisma.knowledgeVersion.upsert({ where: { knowledgeEntryId_version: { knowledgeEntryId: knowledge.id, version: knowledge.currentVersion } }, create: { knowledgeEntryId: knowledge.id, version: knowledge.currentVersion, content, confidence: credibility, verificationStatus, changeReason: existingStory ? "Independent-source confirmation or story update" : "Initial verified intelligence extraction", provenance, changedBy: "system:intelligence" }, update: {} });
    }
    if (classification.expectedImpact !== "LOW" && classification.relatedAssets.length) {
      const impact = classification.expectedImpact as "LOW" | "MEDIUM" | "HIGH";
      await prisma.newsEvent.upsert({ where: { title_eventTime: { title, eventTime: raw.publishedAt ?? item.retrievedAt } }, create: { title, currency: classification.relatedAssets[0], impact, eventTime: raw.publishedAt ?? item.retrievedAt, source: `intelligence:${source.slug}`, raw: { itemId: item.id, verificationStatus, credibility, relatedAssets: classification.relatedAssets } }, update: { impact } });
    }
    stored++;
  }
  await audit({ actor: "system:intelligence", category: "news", action: "intelligence_ingested", detail: { source: source.slug, fetched: raws.length, stored, duplicates } });
  return { fetched: raws.length, stored, duplicates };
}

export async function applyRetention(now = new Date()) {
  const [items, knowledge] = await Promise.all([
    prisma.intelligenceItem.updateMany({ where: { archivedAt: null, expiresAt: { lt: now } }, data: { archivedAt: now } }),
    prisma.knowledgeEntry.updateMany({ where: { status: { in: ["PENDING", "APPROVED"] }, expiresAt: { lt: now } }, data: { status: "EXPIRED", confidence: 0 } }),
  ]);
  return { archivedItems: items.count, expiredKnowledge: knowledge.count };
}
