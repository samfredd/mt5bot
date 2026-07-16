import { prisma } from "../../lib/prisma.js";

export async function generateResearchBrief(type: "DAILY" | "WEEKLY", now = new Date()) {
  const duration = type === "DAILY" ? 24 * 3600_000 : 7 * 24 * 3600_000;
  const periodStart = new Date(now.getTime() - duration);
  const periodEnd = now;
  const items = await prisma.intelligenceItem.findMany({
    where: { publishedAt: { gte: periodStart, lte: periodEnd }, archivedAt: null, relevanceScore: { gte: 0.45 } },
    orderBy: [{ relevanceScore: "desc" }, { publishedAt: "desc" }], take: type === "DAILY" ? 30 : 80,
    include: { source: { select: { name: true } }, story: { select: { verificationStatus: true, sourceCount: true } } },
  });
  const citations = items.map((item) => ({ itemId: item.id, title: item.title, source: item.source.name, url: item.canonicalUrl, publishedAt: item.publishedAt?.toISOString() ?? null, verification: item.verificationStatus }));
  const grouped = new Map<string, typeof items>();
  for (const item of items) grouped.set(item.topic, [...(grouped.get(item.topic) ?? []), item]);
  const content = [...grouped.entries()].map(([topic, rows]) => `## ${topic.replaceAll("_", " ")}\n${rows.slice(0, 5).map((item) => `- ${item.title} [${item.verificationStatus}; ${item.source.name}]`).join("\n")}`).join("\n\n") || "No sufficiently relevant verified intelligence was collected in this period.";
  return prisma.researchBrief.upsert({
    where: { type_periodStart_periodEnd: { type, periodStart, periodEnd } },
    create: { type, periodStart, periodEnd, title: `${type === "DAILY" ? "Daily" : "Weekly"} market-intelligence briefing`, content, citations },
    update: { content, citations },
  });
}
