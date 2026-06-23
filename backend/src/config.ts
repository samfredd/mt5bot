import "dotenv/config";
import { z } from "zod";

// NOTE: z.coerce.boolean() would treat the string "false" as true.
// For safety flags that must never silently flip, parse explicitly.
const strictBool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v.toLowerCase() === "true" || v === "1"));

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  // Independent certification gate. Keep false until deterministic tests,
  // reconciliation, shared execution logic, and profitable OOS criteria pass.
  STRATEGY_VALIDATION_APPROVED: strictBool(false),
  // Fail closed: bypassing 2FA must be an explicit local override.
  REQUIRE_2FA: strictBool(true),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  JWT_EXPIRES_IN: z.string().default("30m"),
  CREDENTIALS_ENC_KEY: z.string().length(64, "CREDENTIALS_ENC_KEY must be 32 bytes hex"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MT5_BRIDGE_URL: z.string().default("http://localhost:5001"),
  MT5_BRIDGE_API_KEY: z.string().default("change-me-bridge-key"),
  MT5_MOCK: strictBool(true),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("gemma3:12b"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().default(60000),
  // The ONE active AI provider. Switchable at runtime via /api/ai/provider too.
  AI_PROVIDER: z.enum(["ollama", "anthropic", "openai", "openrouter"]).default("ollama"),
  // Co-working/fallback is OFF by default — exactly one provider is used.
  AI_RESEARCH_FALLBACK_TO_OLLAMA: strictBool(false),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default(""),
  // OpenAI (and any OpenAI-compatible endpoint via OPENAI_BASE_URL).
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  // OpenRouter (OpenAI-compatible aggregator over many models).
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_MODEL: z.string().default(""),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  NEWS_CALENDAR_URL: z
    .string()
    .default("https://nfs.faireconomy.media/ff_calendar_thisweek.json"),
  NEWS_REFRESH_MINUTES: z.coerce.number().default(15),
  // Comma-separated RSS feeds for breaking-news headlines
  NEWS_RSS_FEEDS: z
    .string()
    .default("https://www.forexlive.com/feed/news,https://www.fxstreet.com/rss/news"),
  // Web search for the Strategy Lab (optional). Empty key = feature disabled.
  WEB_SEARCH_PROVIDER: z.enum(["tavily", "serper"]).default("tavily"),
  WEB_SEARCH_API_KEY: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_ALLOWED_IDS: z.string().default(""),
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_WHATSAPP_FROM: z.string().default(""),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  EMAIL_FROM: z.string().default("bot@example.com"),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production") return;
  const unsafe: string[] = [];
  if (env.JWT_SECRET === "change-me-to-a-long-random-string") unsafe.push("JWT_SECRET");
  if (/^0{64}$/.test(env.CREDENTIALS_ENC_KEY)) unsafe.push("CREDENTIALS_ENC_KEY");
  if (env.MT5_BRIDGE_API_KEY === "change-me-bridge-key") unsafe.push("MT5_BRIDGE_API_KEY");
  if (env.DATABASE_URL.includes("mt5bot:mt5bot@")) unsafe.push("DATABASE_URL");
  if (env.AI_PROVIDER === "anthropic" && (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_MODEL)) unsafe.push("ANTHROPIC_API_KEY/ANTHROPIC_MODEL");
  if (env.AI_PROVIDER === "openai" && (!env.OPENAI_API_KEY || !env.OPENAI_MODEL)) unsafe.push("OPENAI_API_KEY/OPENAI_MODEL");
  if (env.AI_PROVIDER === "openrouter" && (!env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL)) unsafe.push("OPENROUTER_API_KEY/OPENROUTER_MODEL");
  if (unsafe.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unsafe production configuration: ${unsafe.join(", ")}`,
    });
  }
});

export const config = Env.parse(process.env);
export type Config = typeof config;
