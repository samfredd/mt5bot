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
  DEMO_MODE: strictBool(true),
  LIVE_TRADING_ENABLED: strictBool(false),
  // When false, all 2FA checks are bypassed (user opted out "for now").
  // Strongly recommended to set true before trading a funded account.
  REQUIRE_2FA: strictBool(false),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  JWT_EXPIRES_IN: z.string().default("12h"),
  CREDENTIALS_ENC_KEY: z.string().length(64, "CREDENTIALS_ENC_KEY must be 32 bytes hex"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MT5_BRIDGE_URL: z.string().default("http://localhost:5001"),
  MT5_BRIDGE_API_KEY: z.string().default("change-me-bridge-key"),
  MT5_MOCK: strictBool(true),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("gemma3:12b"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().default(60000),
  NEWS_CALENDAR_URL: z
    .string()
    .default("https://nfs.faireconomy.media/ff_calendar_thisweek.json"),
  NEWS_REFRESH_MINUTES: z.coerce.number().default(15),
  // Comma-separated RSS feeds for breaking-news headlines
  NEWS_RSS_FEEDS: z
    .string()
    .default("https://www.forexlive.com/feed/news,https://www.fxstreet.com/rss/news"),
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
});

export const config = Env.parse(process.env);
export type Config = typeof config;
