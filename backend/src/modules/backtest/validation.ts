import type { Candle } from "../mt5/client.js";

const round = (value: number) => Number(value.toFixed(2));

export function splitTrainOos<T extends Candle>(input: T[], oosFraction = 0.2) {
  const fraction = Math.min(Math.max(oosFraction, 0.1), 0.5);
  const sorted = [...input].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const splitIndex = Math.max(1, Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - fraction))));
  const train = sorted.slice(0, splitIndex);
  const oos = sorted.slice(splitIndex);
  return {
    train,
    oos,
    trainStart: train[0]?.time ?? null,
    trainEnd: train.at(-1)?.time ?? null,
    oosStart: oos[0]?.time ?? null,
    oosEnd: oos.at(-1)?.time ?? null,
  };
}

export interface OosEvidence {
  trades: number;
  returnPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  monteCarloReturnP05: number;
}

export function evaluateOosGate(evidence: OosEvidence): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (evidence.trades < 20) reasons.push(`OOS trades ${evidence.trades} below minimum 20`);
  if (evidence.returnPct <= 0) reasons.push(`OOS return ${evidence.returnPct}% is not positive`);
  if (evidence.profitFactor === null || evidence.profitFactor < 1.1) {
    reasons.push(`OOS profit factor ${evidence.profitFactor ?? "n/a"} below 1.1`);
  }
  if (evidence.maxDrawdownPct > 10) reasons.push(`OOS drawdown ${evidence.maxDrawdownPct}% exceeds 10%`);
  if (evidence.monteCarloReturnP05 <= 0) {
    reasons.push(`Monte Carlo 5th-percentile return ${evidence.monteCarloReturnP05}% is not positive`);
  }
  return { passed: reasons.length === 0, reasons };
}

export interface InstrumentValidation {
  symbol: string;
  trades: number;
  returnPct: number;
  maxDrawdownPct: number;
  passed: boolean;
}

export function aggregatePortfolioValidation(results: InstrumentValidation[]) {
  const reasons: string[] = [];
  const profitableInstruments = results.filter((result) => result.returnPct > 0).length;
  const profitableFraction = results.length ? profitableInstruments / results.length : 0;
  const totalTrades = results.reduce((sum, result) => sum + result.trades, 0);
  const meanReturnPct = results.length
    ? results.reduce((sum, result) => sum + result.returnPct, 0) / results.length
    : 0;
  const worstDrawdownPct = results.length ? Math.max(...results.map((result) => result.maxDrawdownPct)) : 0;
  if (results.length < 3) reasons.push("Portfolio validation requires at least 3 instruments");
  if (profitableFraction < 0.6) reasons.push(`Profitable-instrument fraction ${round(profitableFraction)} below 0.6`);
  if (totalTrades < 60) reasons.push(`Portfolio trades ${totalTrades} below minimum 60`);
  if (meanReturnPct <= 0) reasons.push(`Portfolio mean return ${round(meanReturnPct)}% is not positive`);
  if (worstDrawdownPct > 12) reasons.push(`Portfolio worst drawdown ${round(worstDrawdownPct)}% exceeds 12%`);
  return {
    instruments: results.length,
    profitableInstruments,
    profitableFraction: round(profitableFraction),
    totalTrades,
    meanReturnPct: round(meanReturnPct),
    worstDrawdownPct: round(worstDrawdownPct),
    passed: reasons.length === 0,
    reasons,
    results,
  };
}
