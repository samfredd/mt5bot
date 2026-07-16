import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  // Development/test bootstrap defaults keep .env unnecessary. Production
  // rejects these values and must obtain unique secrets from its secret manager.
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars").default("local-development-only-jwt-secret-change-before-production"),
  JWT_EXPIRES_IN: z.string().default("30m"),
  CREDENTIALS_ENC_KEY: z.string().length(64, "CREDENTIALS_ENC_KEY must be 32 bytes hex").default("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
  DATABASE_URL: z.string().default("postgresql://mt5bot:mt5bot@localhost:5433/mt5bot"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production") return;
  const unsafe: string[] = [];
  if (env.JWT_SECRET === "change-me-to-a-long-random-string" || env.JWT_SECRET === "local-development-only-jwt-secret-change-before-production") unsafe.push("JWT_SECRET");
  if (/^0{64}$/.test(env.CREDENTIALS_ENC_KEY) || env.CREDENTIALS_ENC_KEY === "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef") unsafe.push("CREDENTIALS_ENC_KEY");
  if (env.DATABASE_URL.includes("mt5bot:mt5bot@")) unsafe.push("DATABASE_URL");
  if (unsafe.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unsafe production configuration: ${unsafe.join(", ")}`,
    });
  }
});

export const config = Env.parse(process.env);
export type Config = typeof config;
