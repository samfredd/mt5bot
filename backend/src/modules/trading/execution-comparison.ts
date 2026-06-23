import { prisma } from "../../lib/prisma.js";

const rounded = (value: number, digits = 2) => Number(value.toFixed(digits));

export interface ExecutionVarianceInput {
  direction: "BUY" | "SELL";
  expectedEntry: number;
  actualEntry: number;
  expectedExit?: number | null;
  expectedPnl?: number | null;
  actualExit?: number | null;
  actualPnl?: number | null;
  requestedAt: Date;
  filledAt?: Date | null;
}

export function calculateExecutionVariance(input: ExecutionVarianceInput) {
  const entrySlippage = input.direction === "BUY"
    ? input.actualEntry - input.expectedEntry
    : input.expectedEntry - input.actualEntry;
  const hasExit = input.expectedExit !== null && input.expectedExit !== undefined && input.actualExit !== null && input.actualExit !== undefined;
  const exitSlippage = hasExit
    ? input.direction === "BUY"
      ? input.expectedExit! - input.actualExit!
      : input.actualExit! - input.expectedExit!
    : null;
  const hasPnl = input.expectedPnl !== null && input.expectedPnl !== undefined && input.actualPnl !== null && input.actualPnl !== undefined;
  const pnlVariance = hasPnl ? input.actualPnl! - input.expectedPnl! : null;
  return {
    entrySlippage: rounded(entrySlippage, 8),
    entryVariancePct: input.expectedEntry !== 0 ? rounded((entrySlippage / Math.abs(input.expectedEntry)) * 100) : 0,
    exitSlippage: exitSlippage === null ? null : rounded(exitSlippage, 8),
    exitVariancePct: exitSlippage === null || input.expectedExit === 0
      ? null
      : rounded((exitSlippage / Math.abs(input.expectedExit!)) * 100),
    latencyMs: input.filledAt ? Math.max(0, input.filledAt.getTime() - input.requestedAt.getTime()) : null,
    pnlVariance: pnlVariance === null ? null : rounded(pnlVariance),
    pnlVariancePct: pnlVariance === null || input.expectedPnl === 0
      ? null
      : rounded((pnlVariance / Math.abs(input.expectedPnl!)) * 100),
  };
}

export async function recordEntryComparison(input: {
  tradeId: string;
  userId: string;
  direction: "BUY" | "SELL";
  expectedEntry: number;
  actualEntry: number;
  expectedExit?: number | null;
  expectedPnl?: number | null;
  expectedSpreadPoints?: number | null;
  actualSpreadPoints?: number | null;
  expectedSlippagePoints?: number | null;
  requestedAt: Date;
  filledAt: Date;
}) {
  const variance = calculateExecutionVariance(input);
  return prisma.executionComparison.upsert({
    where: { tradeId: input.tradeId },
    create: { ...input, ...variance },
    update: { ...input, ...variance },
  });
}

export async function finalizeExecutionComparison(input: {
  tradeId: string;
  actualExit?: number | null;
  actualPnl?: number | null;
  attributionConfidence: number;
  attributionReason: string;
}) {
  const existing = await prisma.executionComparison.findUnique({ where: { tradeId: input.tradeId } });
  if (!existing) return null;
  const variance = calculateExecutionVariance({
    direction: existing.direction,
    expectedEntry: existing.expectedEntry,
    actualEntry: existing.actualEntry,
    expectedExit: existing.expectedExit,
    actualExit: input.actualExit,
    expectedPnl: existing.expectedPnl,
    actualPnl: input.actualPnl,
    requestedAt: existing.requestedAt,
    filledAt: existing.filledAt,
  });
  return prisma.executionComparison.update({
    where: { tradeId: input.tradeId },
    data: { ...input, ...variance },
  });
}
