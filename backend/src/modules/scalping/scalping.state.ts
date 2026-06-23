import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import {
  ScalpingConfigPatchSchema,
  ScalpingConfigSchema,
  ScalpingRiskPatchSchema,
  ScalpingRiskSchema,
  type ScalpingConfig,
  type ScalpingConfigPatch,
  type ScalpingRiskConfig,
  type ScalpingRiskPatch,
} from "./scalping.schema.js";
import { DEFAULT_SCALPING_CONFIG, DEFAULT_SCALPING_RISK, type ScalpingStatus } from "./scalping.types.js";
import { SCALPING_PRESETS, detectPreset, exposureCapPct, totalExposureExceedsCapForRisk, type ScalpingPresetKey } from "./scalping.presets.js";

/**
 * Persistence for scalping config + scalping-specific risk settings.
 *
 * v1 stores both as `SystemSetting` JSON rows (`scalping`, `scalping_risk`) to
 * avoid a Prisma migration on a live database. The rest of the module only ever
 * touches these accessors, so migrating to the `ScalpingSettings` /
 * `ScalpingRiskSettings` Prisma models later is a change isolated to this file.
 */

const CONFIG_KEY = "scalping";
const RISK_KEY = "scalping_risk";
const CACHE_TTL_MS = 2_000;

let configCache: { value: ScalpingConfig; ts: number } | null = null;
let riskCache: { value: ScalpingRiskConfig; ts: number } | null = null;

export function normalizeLegacyScalpingRisk(value: Partial<ScalpingRiskConfig>): Partial<ScalpingRiskConfig> {
  if (Array.isArray(value.allowedSessions)) {
    const sessions = value.allowedSessions.map((session) => session.toLowerCase());
    const isOldDefault = sessions.length === 2 && sessions.includes("london") && sessions.includes("newyork_overlap");
    if (isOldDefault) return { ...value, allowedSessions: DEFAULT_SCALPING_RISK.allowedSessions };
  }
  return value;
}

export function invalidateScalpingCache(): void {
  configCache = null;
  riskCache = null;
}

export async function getScalpingConfig(): Promise<ScalpingConfig> {
  if (configCache && Date.now() - configCache.ts < CACHE_TTL_MS) return configCache.value;
  const row = await prisma.systemSetting.findUnique({ where: { key: CONFIG_KEY } });
  const merged = { ...DEFAULT_SCALPING_CONFIG, ...((row?.value as Partial<ScalpingConfig>) ?? {}) };
  const value = ScalpingConfigSchema.parse(merged);
  configCache = { value, ts: Date.now() };
  return value;
}

export async function setScalpingConfig(patch: ScalpingConfigPatch, actor: string): Promise<ScalpingConfig> {
  const clean = ScalpingConfigPatchSchema.parse(patch);
  const next = ScalpingConfigSchema.parse({ ...(await getScalpingConfig()), ...clean });
  await prisma.systemSetting.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value: next as object },
    update: { value: next as object },
  });
  invalidateScalpingCache();
  await audit({ actor, category: "system", action: "scalping_config_updated", detail: { patch: clean } });
  // minAiConfidence is a preset-controlled field living in config; keep the
  // preset label (stored in risk) honest when it changes.
  if (clean.minAiConfidence !== undefined) await reconcilePresetLabel();
  return next;
}

/** Recompute the persisted preset label from the current config + risk values. */
async function reconcilePresetLabel(): Promise<void> {
  const [config, risk] = await Promise.all([getScalpingConfig(), getScalpingRisk()]);
  const label = detectPreset(config, risk);
  if (label === risk.scalpingRiskPreset) return;
  const next = { ...risk, scalpingRiskPreset: label };
  await prisma.systemSetting.upsert({
    where: { key: RISK_KEY },
    create: { key: RISK_KEY, value: next as object },
    update: { value: next as object },
  });
  invalidateScalpingCache();
}

export async function getScalpingRisk(): Promise<ScalpingRiskConfig> {
  if (riskCache && Date.now() - riskCache.ts < CACHE_TTL_MS) return riskCache.value;
  const row = await prisma.systemSetting.findUnique({ where: { key: RISK_KEY } });
  const stored = normalizeLegacyScalpingRisk((row?.value as Partial<ScalpingRiskConfig>) ?? {});
  const merged = { ...DEFAULT_SCALPING_RISK, ...stored };
  const value = ScalpingRiskSchema.parse(merged);
  riskCache = { value, ts: Date.now() };
  return value;
}

/** Thrown when a save would breach a hard risk limit; routes turn it into 400. */
export class ScalpingRiskError extends Error {}

export async function setScalpingRisk(
  patch: ScalpingRiskPatch,
  actor: string,
  options: { fromPreset?: boolean } = {},
): Promise<ScalpingRiskConfig> {
  const clean = ScalpingRiskPatchSchema.parse(patch);
  const merged = ScalpingRiskSchema.parse({ ...(await getScalpingRisk()), ...clean });
  // The preset label is derived, never trusted from the patch: a preset apply
  // matches a preset exactly, any manual edit that diverges becomes "custom".
  const config = await getScalpingConfig();
  const next: ScalpingRiskConfig = options.fromPreset
    ? merged
    : { ...merged, scalpingRiskPreset: detectPreset(config, merged) };

  // Hard exposure ceiling — block the save rather than silently allow reckless
  // total open risk (defense in depth; the entry gate checks this too).
  if (totalExposureExceedsCapForRisk(next)) {
    throw new ScalpingRiskError(
      `total exposure ${(next.maxOpenTradesTotal * next.riskPerTradePercent).toFixed(2)}% exceeds the ${exposureCapPct(next.scalpingRiskPreset)}% cap for "${next.scalpingRiskPreset}" — lower max open trades or risk per trade`,
    );
  }

  await prisma.systemSetting.upsert({
    where: { key: RISK_KEY },
    create: { key: RISK_KEY, value: next as object },
    update: { value: next as object },
  });
  invalidateScalpingCache();
  await audit({ actor, category: "risk", action: "scalping_risk_updated", detail: { patch: clean, preset: next.scalpingRiskPreset } });
  return next;
}

/**
 * Apply a named preset: merge its config + risk partials over the current
 * settings. Writes config first so the risk save's preset-label recompute sees
 * the preset's minAiConfidence and resolves to the chosen preset.
 */
export async function applyScalpingPreset(preset: ScalpingPresetKey, actor: string): Promise<{ config: ScalpingConfig; risk: ScalpingRiskConfig }> {
  const def = SCALPING_PRESETS[preset];
  const config = await setScalpingConfig(def.config, actor);
  const risk = await setScalpingRisk(def.risk, actor, { fromPreset: true });
  await audit({ actor, category: "risk", action: "scalping_preset_applied", detail: { preset } });
  return { config, risk };
}

/** Transition the scalping run-state. `running` also flips `enabled` true. */
export async function setScalpingStatus(status: ScalpingStatus, actor: string): Promise<ScalpingConfig> {
  const patch: ScalpingConfigPatch = status === "running"
    ? { status, enabled: true }
    : { status };
  const next = await setScalpingConfig(patch, actor);
  await audit({ actor, category: "system", action: `scalping_${status}`, detail: { status } });
  return next;
}
