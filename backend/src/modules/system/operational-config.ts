import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { prisma } from "../../lib/prisma.js";
import { resetCircuit } from "../../lib/resilience.js";

/**
 * Global, administrator-managed runtime configuration. This is deliberately
 * separate from deployment bootstrap (database/JWT/encryption key): it is
 * loaded only after the database is available and is safe to manage from the
 * Settings screen without restarting the backend.
 */
const KEY = "operational_config";
const CACHE_MS = 5_000;

export const OperationalConfigSchema = z.object({
  strategyValidationApproved: z.boolean().default(false),
  mt5BridgeUrl: z.string().url().default("http://localhost:5001"),
  newsCalendarUrl: z.string().url().default("https://nfs.faireconomy.media/ff_calendar_thisweek.json"),
  newsRefreshMinutes: z.number().int().min(1).max(1440).default(15),
  newsRssFeeds: z.array(z.string().url()).max(20).default([
    "https://www.forexlive.com/feed/news",
    "https://www.fxstreet.com/rss/news",
  ]),
  aiRequestTimeoutMs: z.number().int().min(1_000).max(180_000).default(60_000),
  aiResearchFallbackToOllama: z.boolean().default(false),
  tradingMemoryEnabled: z.boolean().default(true),
  tradingMemoryLookbackTrades: z.number().int().min(20).max(1000).default(200),
  tradingMemoryMinSamples: z.number().int().min(2).max(50).default(5),
  intelligenceApprovalMode: z.enum(["manual", "ai"]).default("ai"),
  intelligenceAiApprovalMinConfidence: z.number().min(0.5).max(0.99).default(0.8),
  telegramAllowedIds: z.array(z.string().regex(/^\d+$/)).max(100).default([]),
  twilioWhatsappFrom: z.string().max(100).default(""),
  webSearchProvider: z.enum(["tavily", "serper"]).default("tavily"),
  mcpEnabled: z.boolean().default(false),
  mcpAllowMutations: z.boolean().default(false),
  mcpAllowTradingActions: z.boolean().default(false),
  mcpAllowedOrigins: z.array(z.string().url()).max(20).default([]),
  strategyAnalysisIntervalMs: z.number().int().min(250).default(60_000),
  protectionIntervalMs: z.number().int().min(250).default(5_000),
  floatingPnlIntervalMs: z.number().int().min(250).default(2_000),
  strategyLabIntervalHours: z.number().positive().default(168),
  intelligencePollIntervalMin: z.number().positive().default(5),
  intelligenceMaintenanceIntervalHours: z.number().positive().default(24),
  scalpingFireIntervalMs: z.number().int().min(100).default(1_000),
  scalpingAiRefreshIntervalMs: z.number().int().min(250).default(15_000),
  scalpingEntryLeaseMs: z.number().int().min(250).default(5_000),
  scalpingBlockAuditThrottleMs: z.number().int().min(0).default(30_000),
  tradeApprovalTtlMin: z.number().positive().default(15),
  assistantConfirmationTtlMin: z.number().positive().default(5),
  paperTradeStaleTickMin: z.number().positive().default(5),
  paperExpectedSlippagePoints: z.number().min(0).default(2),
  paperCommissionPerLot: z.number().min(0).default(7),
  notificationHistoryLimit: z.number().int().positive().default(50),
});

export type OperationalConfig = z.infer<typeof OperationalConfigSchema>;
type StoredConfig = OperationalConfig & {
  mt5BridgeApiKeyEnc?: string;
  telegramBotTokenEnc?: string;
  twilioAccountSidEnc?: string;
  twilioAuthTokenEnc?: string;
  webSearchApiKeyEnc?: string;
  youtubeApiKeyEnc?: string;
  githubTokenEnc?: string;
  xBearerTokenEnc?: string;
  mcpTokenHash?: string;
  mcpUserId?: string;
  mcpTokenCreatedAt?: string;
};

export interface ResolvedOperationalConfig extends OperationalConfig {
  mt5BridgeApiKey: string;
  telegramBotToken: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  webSearchApiKey: string;
  youtubeApiKey: string;
  githubToken: string;
  xBearerToken: string;
  mcpTokenHash: string;
  mcpUserId: string;
  mcpTokenCreatedAt: string;
}

export interface OperationalConfigSummary extends OperationalConfig {
  hasMt5BridgeApiKey: boolean;
  hasTelegramBotToken: boolean;
  hasTwilioAccountSid: boolean;
  hasTwilioAuthToken: boolean;
  hasWebSearchApiKey: boolean;
  hasYoutubeApiKey: boolean;
  hasGithubToken: boolean;
  hasXBearerToken: boolean;
  hasMcpAccessToken: boolean;
  mcpTokenCreatedAt: string | null;
}

export interface OperationalConfigPatch extends Partial<OperationalConfig> {
  mt5BridgeApiKey?: string;
  telegramBotToken?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  webSearchApiKey?: string;
  youtubeApiKey?: string;
  githubToken?: string;
  xBearerToken?: string;
  clearMt5BridgeApiKey?: boolean;
  clearTelegramBotToken?: boolean;
  clearTwilioAccountSid?: boolean;
  clearTwilioAuthToken?: boolean;
  clearWebSearchApiKey?: boolean;
  clearYoutubeApiKey?: boolean;
  clearGithubToken?: boolean;
  clearXBearerToken?: boolean;
}

let cache: { value: StoredConfig; at: number } | null = null;

function defaults(): OperationalConfig {
  return OperationalConfigSchema.parse({});
}

async function stored(): Promise<StoredConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let row: { value: unknown } | null = null;
  try {
    row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  } catch {
    // Startup/health paths must remain readable while the DB is recovering.
    // Operations that need a configured secret still fail closed later.
  }
  const parsed = OperationalConfigSchema.safeParse(row?.value ?? {});
  const value: StoredConfig = {
    ...defaults(),
    ...(parsed.success ? parsed.data : {}),
    ...((row?.value ?? {}) as Pick<StoredConfig, "mt5BridgeApiKeyEnc" | "telegramBotTokenEnc" | "twilioAccountSidEnc" | "twilioAuthTokenEnc" | "webSearchApiKeyEnc" | "youtubeApiKeyEnc" | "githubTokenEnc" | "xBearerTokenEnc" | "mcpTokenHash" | "mcpUserId" | "mcpTokenCreatedAt">),
  };
  if (!row && prisma.systemSetting?.upsert) {
    await prisma.systemSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: value as object },
      update: {},
    }).catch(() => undefined);
  }
  cache = { value, at: Date.now() };
  return value;
}

const readSecret = (payload?: string) => {
  if (!payload) return "";
  try { return decryptSecret(payload); } catch { return ""; }
};

export async function getOperationalConfig(): Promise<ResolvedOperationalConfig> {
  const value = await stored();
  return {
    ...OperationalConfigSchema.parse(value),
    mt5BridgeApiKey: readSecret(value.mt5BridgeApiKeyEnc),
    telegramBotToken: readSecret(value.telegramBotTokenEnc),
    twilioAccountSid: readSecret(value.twilioAccountSidEnc),
    twilioAuthToken: readSecret(value.twilioAuthTokenEnc),
    webSearchApiKey: readSecret(value.webSearchApiKeyEnc),
    youtubeApiKey: readSecret(value.youtubeApiKeyEnc),
    githubToken: readSecret(value.githubTokenEnc),
    xBearerToken: readSecret(value.xBearerTokenEnc),
    mcpTokenHash: value.mcpTokenHash ?? "",
    mcpUserId: value.mcpUserId ?? "",
    mcpTokenCreatedAt: value.mcpTokenCreatedAt ?? "",
  };
}

export async function getOperationalConfigSummary(): Promise<OperationalConfigSummary> {
  const value = await stored();
  return {
    ...OperationalConfigSchema.parse(value),
    hasMt5BridgeApiKey: Boolean(value.mt5BridgeApiKeyEnc),
    hasTelegramBotToken: Boolean(value.telegramBotTokenEnc),
    hasTwilioAccountSid: Boolean(value.twilioAccountSidEnc),
    hasTwilioAuthToken: Boolean(value.twilioAuthTokenEnc),
    hasWebSearchApiKey: Boolean(value.webSearchApiKeyEnc),
    hasYoutubeApiKey: Boolean(value.youtubeApiKeyEnc),
    hasGithubToken: Boolean(value.githubTokenEnc),
    hasXBearerToken: Boolean(value.xBearerTokenEnc),
    hasMcpAccessToken: Boolean(value.mcpTokenHash && value.mcpUserId),
    mcpTokenCreatedAt: value.mcpTokenCreatedAt ?? null,
  };
}

export async function updateOperationalConfig(patch: OperationalConfigPatch): Promise<OperationalConfigSummary> {
  const current = await stored();
  const plainPatch = OperationalConfigSchema.partial().parse(patch);
  const next: StoredConfig = { ...current, ...plainPatch };
  const secrets: Array<["mt5BridgeApiKeyEnc" | "telegramBotTokenEnc" | "twilioAccountSidEnc" | "twilioAuthTokenEnc" | "webSearchApiKeyEnc" | "youtubeApiKeyEnc" | "githubTokenEnc" | "xBearerTokenEnc", keyof OperationalConfigPatch, keyof OperationalConfigPatch]> = [
    ["mt5BridgeApiKeyEnc", "mt5BridgeApiKey", "clearMt5BridgeApiKey"],
    ["telegramBotTokenEnc", "telegramBotToken", "clearTelegramBotToken"],
    ["twilioAccountSidEnc", "twilioAccountSid", "clearTwilioAccountSid"],
    ["twilioAuthTokenEnc", "twilioAuthToken", "clearTwilioAuthToken"],
    ["webSearchApiKeyEnc", "webSearchApiKey", "clearWebSearchApiKey"],
    ["youtubeApiKeyEnc", "youtubeApiKey", "clearYoutubeApiKey"],
    ["githubTokenEnc", "githubToken", "clearGithubToken"],
    ["xBearerTokenEnc", "xBearerToken", "clearXBearerToken"],
  ];
  for (const [storedKey, inputKey, clearKey] of secrets) {
    if (patch[clearKey]) delete next[storedKey];
    else if (typeof patch[inputKey] === "string" && patch[inputKey]!.trim()) {
      next[storedKey] = encryptSecret(patch[inputKey]!.trim());
    }
  }
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as object },
    update: { value: next as object },
  });
  if (patch.mt5BridgeUrl !== undefined || patch.mt5BridgeApiKey !== undefined || patch.clearMt5BridgeApiKey) {
    // A repaired URL/key must be tried immediately; an old open/half-open
    // circuit otherwise keeps rejecting reads even after the dependency works.
    await resetCircuit("mt5");
  }
  cache = { value: next, at: Date.now() };
  return getOperationalConfigSummary();
}

export function __resetOperationalConfigCacheForTests(): void {
  cache = null;
}

const hashMcpToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createMcpAccessToken(userId: string): Promise<{ token: string; createdAt: string }> {
  const token = `mt5mcp_${randomBytes(32).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  const next: StoredConfig = {
    ...await stored(),
    mcpTokenHash: hashMcpToken(token),
    mcpUserId: userId,
    mcpTokenCreatedAt: createdAt,
  };
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as object },
    update: { value: next as object },
  });
  cache = { value: next, at: Date.now() };
  return { token, createdAt };
}

export async function revokeMcpAccessToken(): Promise<void> {
  const next: StoredConfig = { ...await stored() };
  delete next.mcpTokenHash;
  delete next.mcpUserId;
  delete next.mcpTokenCreatedAt;
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as object },
    update: { value: next as object },
  });
  cache = { value: next, at: Date.now() };
}

export async function verifyMcpAccessToken(token: string): Promise<{ userId: string } | null> {
  if (!token || token.length > 200) return null;
  const value = await stored();
  if (!value.mcpTokenHash || !value.mcpUserId) return null;
  const actual = Buffer.from(hashMcpToken(token), "hex");
  const expected = Buffer.from(value.mcpTokenHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { userId: value.mcpUserId };
}
