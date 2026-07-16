import type { IntelligenceSource } from "@prisma/client";
import { withResilience } from "../../lib/resilience.js";
import { getOperationalConfig } from "../system/operational-config.js";
import { sanitizeExternalText } from "./security.js";
import type { RawIntelligenceItem } from "./pipeline.js";

const decode = (value: string) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
const tag = (block: string, names: string[]) => {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return decode(match[1]).trim();
  }
  return "";
};
const attrLink = (block: string) => block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? "";

export function parseStructuredFeed(xml: string): RawIntelligenceItem[] {
  const blocks = [...(xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []), ...(xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [])];
  return blocks.map((block) => {
    const title = sanitizeExternalText(tag(block, ["title"]), 500);
    const content = sanitizeExternalText(tag(block, ["description", "content", "content:encoded", "summary"]));
    const rawDate = tag(block, ["pubDate", "published", "updated", "dc:date"]);
    const date = rawDate ? new Date(rawDate) : null;
    return {
      externalId: tag(block, ["guid", "id"]) || undefined,
      url: tag(block, ["link"]) || attrLink(block) || undefined,
      title,
      author: sanitizeExternalText(tag(block, ["author", "dc:creator"]), 300) || undefined,
      content,
      publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
      kind: "NEWS",
    };
  }).filter((item) => item.title);
}

async function fetchText(url: string, headers: Record<string, string> = {}) {
  return withResilience("intelligence", async () => {
    const response = await fetch(url, { headers: { "user-agent": "MT5Bot-Intelligence/1.0 (+structured-source-ingestion)", ...headers }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
    return { text: await response.text(), headers: response.headers };
  }, { retries: 2, baseDelayMs: 500, maxDelayMs: 4000, failureThreshold: 4, cooldownMs: 120_000 });
}

async function rss(source: IntelligenceSource): Promise<{ items: RawIntelligenceItem[]; remaining?: number }> {
  if (!source.feedUrl) return { items: [] };
  const { text } = await fetchText(source.feedUrl);
  return { items: parseStructuredFeed(text) };
}

async function youtube(): Promise<{ items: RawIntelligenceItem[]; remaining?: number }> {
  const key = (await getOperationalConfig()).youtubeApiKey;
  if (!key) throw new Error("YouTube API key is not configured in Settings");
  const query = encodeURIComponent("forex OR central bank OR inflation OR gold market analysis");
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=15&publishedAfter=${encodeURIComponent(new Date(Date.now() - 26 * 3600_000).toISOString())}&q=${query}&key=${encodeURIComponent(key)}`;
  const { text } = await fetchText(url);
  const body = JSON.parse(text) as { items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; description?: string; channelTitle?: string; publishedAt?: string } }> };
  return { items: (body.items ?? []).map((row) => ({ externalId: row.id?.videoId, url: row.id?.videoId ? `https://www.youtube.com/watch?v=${row.id.videoId}` : undefined, title: row.snippet?.title ?? "", author: row.snippet?.channelTitle, content: row.snippet?.description ?? "", publishedAt: row.snippet?.publishedAt ? new Date(row.snippet.publishedAt) : null, kind: "VIDEO", raw: { transcriptStatus: "not_available_via_public_metadata_api", videoId: row.id?.videoId } })).filter((item) => item.title) };
}

async function github(): Promise<{ items: RawIntelligenceItem[]; remaining?: number }> {
  const token = (await getOperationalConfig()).githubToken;
  const url = "https://api.github.com/search/repositories?q=algorithmic+trading+forex+pushed:%3E" + new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10) + "&sort=updated&order=desc&per_page=15";
  const { text, headers } = await fetchText(url, { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const body = JSON.parse(text) as { items?: Array<{ id: number; html_url: string; full_name: string; description: string | null; updated_at: string; stargazers_count: number; owner?: { login?: string } }> };
  return { remaining: Number(headers.get("x-ratelimit-remaining") ?? "") || undefined, items: (body.items ?? []).map((row) => ({ externalId: String(row.id), url: row.html_url, title: row.full_name, author: row.owner?.login, content: row.description ?? "No repository description", publishedAt: new Date(row.updated_at), kind: "DEVELOPER", engagement: { stars: row.stargazers_count }, raw: { warning: "Repository metadata is research input, not validated strategy evidence." } })) };
}

async function xSearch(): Promise<{ items: RawIntelligenceItem[]; remaining?: number }> {
  const token = (await getOperationalConfig()).xBearerToken;
  if (!token) throw new Error("X bearer token is not configured in Settings");
  const query = encodeURIComponent('(forex OR "central bank" OR inflation OR gold) lang:en -is:retweet');
  const { text, headers } = await fetchText(`https://api.x.com/2/tweets/search/recent?query=${query}&max_results=25&tweet.fields=created_at,author_id,public_metrics`, { authorization: `Bearer ${token}` });
  const body = JSON.parse(text) as { data?: Array<{ id: string; text: string; author_id?: string; created_at?: string; public_metrics?: Record<string, number> }> };
  return { remaining: Number(headers.get("x-rate-limit-remaining") ?? "") || undefined, items: (body.data ?? []).map((row) => ({ externalId: row.id, url: `https://x.com/i/web/status/${row.id}`, title: row.text.slice(0, 180), author: row.author_id, content: row.text, publishedAt: row.created_at ? new Date(row.created_at) : null, kind: "COMMUNITY", engagement: row.public_metrics, raw: { classification: "community_opinion_unverified" } })) };
}

export async function fetchSource(source: IntelligenceSource) {
  if (["RSS", "LICENSED_RSS"].includes(source.accessMethod)) return rss(source);
  if (source.accessMethod === "YOUTUBE_API") return youtube();
  if (source.accessMethod === "GITHUB_API") return github();
  if (source.accessMethod === "X_API") return xSearch();
  throw new Error(`${source.accessMethod} requires a licensed connector or an operator-authorized integration and is not called without credentials`);
}
