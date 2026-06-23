import { classifyInstrument } from "../risk/instruments.js";

/**
 * Sentinel symbol meaning "every FX pair the broker offers". A strategy whose
 * `symbols` contains this is expanded at scan time to the live broker FX
 * universe — so it trades any currency pair without hard-coding a list that
 * goes stale when the broker adds/removes pairs.
 */
export const ALL_FX = "ALL_FX";

/**
 * Cap on how many pairs ALL_FX expands to. Each pair costs a tick + candle
 * fetch + analysis (+ an AI call on a fresh bar) every scheduler tick, so an
 * unbounded broker list (some offer 60+ FX symbols) would hammer the bridge
 * and the model. 40 covers all majors + the liquid crosses with headroom.
 */
export const ALL_FX_CAP = 40;

/**
 * Resolve a strategy's configured symbols against the live broker universe,
 * expanding the {@link ALL_FX} sentinel into every FX pair the broker prices.
 * Non-sentinel symbols pass through untouched (the live pipeline resolves any
 * broker suffix later). Order is preserved and duplicates are removed.
 */
export function expandStrategySymbols(configured: string[], available: string[]): string[] {
  const fxUniverse = available.filter((s) => classifyInstrument(s).kind === "fx").slice(0, ALL_FX_CAP);
  const out: string[] = [];
  for (const sym of configured) {
    if (sym.toUpperCase() === ALL_FX) out.push(...fxUniverse);
    else out.push(sym);
  }
  return [...new Set(out)];
}
