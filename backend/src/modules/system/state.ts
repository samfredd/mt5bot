import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { config } from "../../config.js";

export type BotStatus = "stopped" | "running" | "paused" | "emergency_stop";

export interface BotState {
  status: BotStatus;
  mode: "MANUAL" | "SEMI_AUTO" | "AUTO" | "COPY";
  emergencyStop: boolean;
  demoMode: boolean;
  liveTradingEnabled: boolean;
}

const defaults: BotState = {
  status: "stopped",
  mode: "MANUAL",
  emergencyStop: false,
  demoMode: config.DEMO_MODE,
  liveTradingEnabled: false,
};

let cache: BotState | null = null;

export async function getBotState(): Promise<BotState> {
  if (cache) return cache;
  const row = await prisma.systemSetting.findUnique({ where: { key: "bot_state" } });
  cache = row ? { ...defaults, ...(row.value as Partial<BotState>) } : { ...defaults };
  // Safety rails enforced on every load, regardless of what was persisted:
  // env-level kill switch wins over anything in the database.
  if (!config.LIVE_TRADING_ENABLED) cache.liveTradingEnabled = false;
  if (config.DEMO_MODE) cache.demoMode = true;
  return cache;
}

export async function setBotState(patch: Partial<BotState>, actor: string): Promise<BotState> {
  const current = await getBotState();
  const next = { ...current, ...patch };
  // Emergency stop overrides everything and forces status.
  if (next.emergencyStop) next.status = "emergency_stop";
  if (!config.LIVE_TRADING_ENABLED) next.liveTradingEnabled = false;
  cache = next;
  await prisma.systemSetting.upsert({
    where: { key: "bot_state" },
    create: { key: "bot_state", value: next as object },
    update: { value: next as object },
  });
  await audit({ actor, category: "system", action: "bot_state_changed", detail: { patch, next } });
  return next;
}

/** True when no new trades may be opened at all. */
export async function tradingHalted(): Promise<boolean> {
  const s = await getBotState();
  return s.emergencyStop || s.status !== "running";
}
