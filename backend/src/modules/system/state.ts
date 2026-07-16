import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { redisAvailable, writeJson } from "../../lib/redis.js";

export type BotStatus = "stopped" | "running" | "paused" | "emergency_stop";

export interface BotState {
  status: BotStatus;
  mode: "MANUAL" | "SEMI_AUTO" | "AUTO" | "COPY";
  emergencyStop: boolean;
  demoMode: boolean;
  liveTradingEnabled: boolean;
  paperForward: boolean;
  // Whether live (real-account) trades require a 2FA confirmation. When true,
  // manual/approval live trades need a per-action TOTP; the automated bot can
  // only trade live if `autoLiveAuthorized` is also set (it can't enter a code).
  requireLiveTwoFactor: boolean;
  // Standing authorization for the AUTOMATED bot to place live trades without a
  // per-trade TOTP. Only consulted on the auto path while requireLiveTwoFactor
  // is true; ignored (not needed) when 2FA is off.
  autoLiveAuthorized: boolean;
  // Dynamically cap risk and let the selected AI reduce (never increase) the
  // equity-sized lot recommendation.
  adaptiveRiskEnabled: boolean;
}

const defaults: BotState = {
  status: "stopped",
  mode: "MANUAL",
  emergencyStop: false,
  demoMode: true,
  liveTradingEnabled: false,
  paperForward: false,
  requireLiveTwoFactor: true,
  autoLiveAuthorized: false,
  adaptiveRiskEnabled: true,
};

let cache: BotState | null = null;
let cacheAt = 0;
const REDIS_STATE_KEY = "bot:state";
const CACHE_TTL_MS = 2_000;

export async function getBotState(): Promise<BotState> {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  // PostgreSQL is authoritative. Redis is only a mirror and must never revive
  // an older running/live state after a restart or cross-instance update.
  const row = await prisma.systemSetting.findUnique({ where: { key: "bot_state" } });
  cache = row ? { ...defaults, ...(row.value as Partial<BotState>) } : { ...defaults };
  cacheAt = Date.now();
  await writeJson(REDIS_STATE_KEY, cache);
  return cache;
}

export async function setBotState(patch: Partial<BotState>, actor: string): Promise<BotState> {
  const current = await getBotState();
  const next = { ...current, ...patch };
  // Emergency stop overrides everything and forces status.
  if (next.emergencyStop) next.status = "emergency_stop";
  cache = next;
  cacheAt = Date.now();
  await prisma.systemSetting.upsert({
    where: { key: "bot_state" },
    create: { key: "bot_state", value: next as object },
    update: { value: next as object },
  });
  await writeJson(REDIS_STATE_KEY, next);
  await audit({ actor, category: "system", action: "bot_state_changed", detail: { patch, next } });
  return next;
}

/** Redis is required for coordinated new-trade evaluation. */
export async function operationalTradingAvailable(): Promise<boolean> {
  return redisAvailable();
}

/** True when no new trades may be opened at all. */
export async function tradingHalted(): Promise<boolean> {
  const s = await getBotState();
  return s.emergencyStop || s.status !== "running" || !(await operationalTradingAvailable());
}
