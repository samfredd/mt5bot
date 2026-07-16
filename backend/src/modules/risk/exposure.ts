import { classifyInstrument } from "./instruments.js";

export interface ExposurePosition {
  symbol: string;
  direction: "buy" | "sell";
  lots: number;
  price: number;
}

export interface ExposureSnapshot {
  currencyUsd: Record<string, number>;
  symbolUsd: Record<string, number>;
  correlationGroups: Record<string, { grossUsd: number; netUsd: number }>;
}

const rounded = (value: number) => Number(value.toFixed(2));

function correlationGroup(symbol: string): string {
  const instrument = classifyInstrument(symbol);
  const upper = symbol.toUpperCase();
  if (instrument.kind === "fx" && (instrument.baseCurrency === "USD" || instrument.quoteCurrency === "USD")) return "USD_FX";
  if (instrument.kind === "metal") return "METALS";
  if (instrument.kind === "crypto") return "CRYPTO";
  if (/^(US30|US500|USTEC|NAS100|SPX500|DJ30|DOW)/.test(upper)) return "US_INDICES";
  return `SYMBOL:${upper}`;
}

function usdNotional(position: ExposurePosition): number {
  const instrument = classifyInstrument(position.symbol);
  const units = position.lots * instrument.contractSize;
  if (instrument.kind === "fx" && instrument.baseCurrency === "USD") return units;
  if (instrument.kind === "fx" && instrument.quoteCurrency === "USD") return units * position.price;
  // A cross such as EURJPY is quoted in JPY, so `units * price` is a JPY
  // notional, not a USD notional. Without a live conversion pair in this pure
  // risk helper, use contract units as a conservative USD approximation. This
  // avoids inflating JPY crosses by roughly 100-200x while still subjecting
  // them to the configured exposure ceiling.
  if (instrument.kind === "fx") return units;
  return units * position.price;
}

export interface ExposureGateResult {
  passed: boolean;
  reasons: string[];
  projected: ExposureSnapshot;
  adjustedLots?: number;
}

export function calculateExposure(positions: ExposurePosition[]): ExposureSnapshot {
  const currencyUsd: Record<string, number> = {};
  const symbolUsd: Record<string, number> = {};
  const correlationGroups: Record<string, { grossUsd: number; netUsd: number }> = {};
  for (const position of positions) {
    const instrument = classifyInstrument(position.symbol);
    const sign = position.direction === "buy" ? 1 : -1;
    const notional = usdNotional(position);
    const signed = sign * notional;
    const symbol = position.symbol.toUpperCase();
    symbolUsd[symbol] = rounded((symbolUsd[symbol] ?? 0) + signed);
    if (instrument.baseCurrency) {
      currencyUsd[instrument.baseCurrency] = rounded((currencyUsd[instrument.baseCurrency] ?? 0) + signed);
      currencyUsd[instrument.quoteCurrency] = rounded((currencyUsd[instrument.quoteCurrency] ?? 0) - signed);
    } else {
      currencyUsd[instrument.quoteCurrency] = rounded((currencyUsd[instrument.quoteCurrency] ?? 0) + signed);
    }
    const groupName = correlationGroup(position.symbol);
    const group = correlationGroups[groupName] ?? { grossUsd: 0, netUsd: 0 };
    group.grossUsd = rounded(group.grossUsd + Math.abs(notional));
    group.netUsd = rounded(group.netUsd + signed);
    correlationGroups[groupName] = group;
  }
  return { currencyUsd, symbolUsd, correlationGroups };
}

export function evaluateExposureGate(input: {
  positions: ExposurePosition[];
  proposal: ExposurePosition;
  accountEquity: number;
  maxCurrencyExposurePct: number;
  maxCorrelatedExposurePct: number;
}): ExposureGateResult {
  const projected = calculateExposure([...input.positions, input.proposal]);
  const reasons: string[] = [];
  if (input.accountEquity <= 0) return { passed: false, reasons: ["Account equity must be positive"], projected };
  for (const [currency, value] of Object.entries(projected.currencyUsd)) {
    const pct = rounded((Math.abs(value) / input.accountEquity) * 100);
    if (pct > input.maxCurrencyExposurePct) {
      reasons.push(`${currency} net exposure ${pct}% exceeds ${input.maxCurrencyExposurePct}%`);
    }
  }
  for (const [group, value] of Object.entries(projected.correlationGroups)) {
    const pct = rounded((value.grossUsd / input.accountEquity) * 100);
    if (pct > input.maxCorrelatedExposurePct) {
      reasons.push(`${group} gross exposure ${pct}% exceeds ${input.maxCorrelatedExposurePct}%`);
    }
  }
  return { passed: reasons.length === 0, reasons, projected };
}

/**
 * Reduce a proposal to the largest broker-valid size that fits the configured
 * exposure limits. Exposure remains a hard gate: if even the minimum lot does
 * not fit, the proposal is rejected rather than forced through.
 */
export function fitLotsToExposure(input: {
  positions: ExposurePosition[];
  proposal: ExposurePosition;
  accountEquity: number;
  maxCurrencyExposurePct: number;
  maxCorrelatedExposurePct: number;
  volumeMin: number;
  volumeStep: number;
}): ExposureGateResult {
  const initial = evaluateExposureGate(input);
  if (initial.passed) return initial;

  const step = Math.max(input.volumeStep, 0.00000001);
  const min = Math.max(input.volumeMin, step);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  let lots = Math.floor((input.proposal.lots - step + step * 1e-9) / step) * step;

  while (lots >= min - step * 1e-9) {
    const candidateLots = Number(Math.max(lots, min).toFixed(decimals));
    const candidate = evaluateExposureGate({
      ...input,
      proposal: { ...input.proposal, lots: candidateLots },
    });
    if (candidate.passed) {
      return {
        ...candidate,
        adjustedLots: candidateLots,
        reasons: [`lot size reduced from ${input.proposal.lots} to ${candidateLots} to remain within exposure limits`],
      };
    }
    lots = Number((lots - step).toFixed(decimals));
  }

  return initial;
}
