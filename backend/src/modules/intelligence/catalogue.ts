import { prisma } from "../../lib/prisma.js";
import { getOperationalConfig } from "../system/operational-config.js";

export const SOURCE_CATALOGUE = [
  { slug: "federal-reserve", name: "Federal Reserve", category: "OFFICIAL", accessMethod: "RSS", homepageUrl: "https://www.federalreserve.gov/", feedUrl: "https://www.federalreserve.gov/feeds/press_all.xml", official: true, enabled: true, approved: true, baseReliability: 0.98, pollIntervalMin: 10, termsNote: "Official public RSS; preserve attribution and links." },
  { slug: "ecb", name: "European Central Bank", category: "OFFICIAL", accessMethod: "RSS", homepageUrl: "https://www.ecb.europa.eu/", feedUrl: "https://www.ecb.europa.eu/rss/press.html", official: true, enabled: true, approved: true, baseReliability: 0.98, pollIntervalMin: 10, termsNote: "Official ECB RSS/MID structured publication." },
  { slug: "bbc-business", name: "BBC Business", category: "NEWS", accessMethod: "LICENSED_RSS", homepageUrl: "https://www.bbc.com/business", feedUrl: "https://feeds.bbci.co.uk/news/business/rss.xml", official: false, enabled: false, approved: false, baseReliability: 0.82, pollIntervalMin: 15, termsNote: "Business/commercial RSS reuse requires BBC permission or metadata licence." },
  { slug: "al-jazeera", name: "Al Jazeera", category: "NEWS", accessMethod: "RSS", homepageUrl: "https://www.aljazeera.com/", feedUrl: "https://www.aljazeera.com/xml/rss/all.xml", official: false, enabled: false, approved: false, baseReliability: 0.75, pollIntervalMin: 15, termsNote: "Enable only after confirming syndication terms for this deployment." },
  { slug: "marketwatch", name: "MarketWatch", category: "NEWS", accessMethod: "LICENSED_RSS", homepageUrl: "https://www.marketwatch.com/", feedUrl: "https://feeds.marketwatch.com/marketwatch/topstories/", official: false, enabled: false, approved: false, baseReliability: 0.78, pollIntervalMin: 15, termsNote: "Metadata/headline use only unless licensed for full content." },
  { slug: "reuters", name: "Reuters", category: "NEWS", accessMethod: "LICENSED_API", homepageUrl: "https://reutersagency.com/content-delivery-platforms/reuters-connect/", official: false, enabled: false, approved: false, baseReliability: 0.94, pollIntervalMin: 5, termsNote: "Requires Reuters Connect/API content licence; never scrape." },
  { slug: "associated-press", name: "Associated Press", category: "NEWS", accessMethod: "LICENSED_API", homepageUrl: "https://developer.ap.org/ap-media-api/", official: false, enabled: false, approved: false, baseReliability: 0.93, pollIntervalMin: 5, termsNote: "Requires AP Media API licensed-content entitlement." },
  { slug: "bloomberg", name: "Bloomberg", category: "NEWS", accessMethod: "LICENSED_API", homepageUrl: "https://www.bloomberg.com/professional/", official: false, enabled: false, approved: false, baseReliability: 0.92, pollIntervalMin: 5, termsNote: "Requires Bloomberg enterprise/data licence; never scrape." },
  { slug: "financial-times", name: "Financial Times", category: "NEWS", accessMethod: "LICENSED_API", homepageUrl: "https://www.ft.com/", official: false, enabled: false, approved: false, baseReliability: 0.9, pollIntervalMin: 15, termsNote: "Requires commercial content/API licence." },
  { slug: "wall-street-journal", name: "Wall Street Journal", category: "NEWS", accessMethod: "LICENSED_API", homepageUrl: "https://www.wsj.com/", official: false, enabled: false, approved: false, baseReliability: 0.9, pollIntervalMin: 15, termsNote: "Requires Dow Jones/Factiva content licence." },
  { slug: "youtube", name: "YouTube Research", category: "VIDEO", accessMethod: "YOUTUBE_API", homepageUrl: "https://www.youtube.com/", official: false, enabled: false, approved: false, baseReliability: 0.4, pollIntervalMin: 60, termsNote: "Official Data API only. Metadata is quota-limited; captions require legal availability/authorization." },
  { slug: "github", name: "GitHub Trading Research", category: "DEVELOPER", accessMethod: "GITHUB_API", homepageUrl: "https://github.com/", official: false, enabled: false, approved: false, baseReliability: 0.45, pollIntervalMin: 180, termsNote: "Public REST API only; repository popularity is not evidence of correctness." },
  { slug: "x", name: "X Market Discussion", category: "COMMUNITY", accessMethod: "X_API", homepageUrl: "https://x.com/", official: false, enabled: false, approved: false, baseReliability: 0.25, pollIntervalMin: 15, termsNote: "Official paid API only; scraping and use for model training are prohibited." },
  { slug: "reddit", name: "Reddit Trading Communities", category: "COMMUNITY", accessMethod: "REDDIT_API", homepageUrl: "https://www.reddit.com/", official: false, enabled: false, approved: false, baseReliability: 0.25, pollIntervalMin: 60, termsNote: "Official Data API/OAuth and current terms required; no private communities." },
  { slug: "discord", name: "Approved Discord Channels", category: "COMMUNITY", accessMethod: "DISCORD_BOT", homepageUrl: "https://discord.com/", official: false, enabled: false, approved: false, baseReliability: 0.25, pollIntervalMin: 60, termsNote: "Bot must be explicitly installed with VIEW_CHANNEL and READ_MESSAGE_HISTORY; no private access bypass." },
] as const;

export async function ensureSourceCatalogue(): Promise<number> {
  let count = 0;
  for (const source of SOURCE_CATALOGUE) {
    await prisma.intelligenceSource.upsert({
      where: { slug: source.slug },
      create: { ...source, reliabilityScore: source.baseReliability },
      update: { name: source.name, category: source.category, accessMethod: source.accessMethod, homepageUrl: source.homepageUrl, feedUrl: "feedUrl" in source ? source.feedUrl : null, official: source.official, baseReliability: source.baseReliability, termsNote: source.termsNote },
    });
    count++;
  }
  const configuredFeeds = (await getOperationalConfig()).newsRssFeeds;
  for (const feedUrl of configuredFeeds) {
    const host = new URL(feedUrl).hostname.replace(/^www\./, "");
    const slug = `configured-rss-${host.replace(/[^a-z0-9]+/g, "-")}`;
    await prisma.intelligenceSource.upsert({ where: { slug }, create: { slug, name: host, category: "NEWS", accessMethod: "RSS", homepageUrl: `https://${host}`, feedUrl, enabled: true, approved: true, baseReliability: 0.65, reliabilityScore: 0.65, pollIntervalMin: 15, termsNote: "Operator-configured RSS; operator is responsible for syndication rights." }, update: { feedUrl } });
    count++;
  }
  return count;
}
