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
  return units * position.price;
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
}) {
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
