import type { Prisma, ValidationStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

export interface ValidationRunInput {
  userId: string;
  strategyId?: string;
  candidateName: string;
  symbol: string;
  status: ValidationStatus;
  trigger: string;
  trainStart?: string | null;
  trainEnd?: string | null;
  oosStart?: string | null;
  oosEnd?: string | null;
  instruments: string[];
  metrics: unknown;
  gates: unknown;
  rejectionReasons: string[];
}

const date = (value?: string | null) => value ? new Date(value) : null;
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const INFRASTRUCTURE_ERROR = /(CircuitOpenError|circuit is open|redis unavailable|bridge unavailable|operational trading unavailable)/i;

export function recordValidationRun(input: ValidationRunInput) {
  return prisma.validationRun.create({
    data: {
      userId: input.userId,
      strategyId: input.strategyId,
      candidateName: input.candidateName,
      symbol: input.symbol,
      status: input.status,
      trigger: input.trigger,
      trainStart: date(input.trainStart),
      trainEnd: date(input.trainEnd),
      oosStart: date(input.oosStart),
      oosEnd: date(input.oosEnd),
      instruments: input.instruments,
      metrics: jsonValue(input.metrics),
      gates: jsonValue(input.gates),
      rejectionReasons: input.rejectionReasons,
    },
  });
}

export function isInfrastructureValidationError(run: { status: ValidationStatus; rejectionReasons: unknown }): boolean {
  if (run.status !== "ERROR") return false;
  const reasons = Array.isArray(run.rejectionReasons) ? run.rejectionReasons : [];
  return reasons.some((reason) => INFRASTRUCTURE_ERROR.test(String(reason)));
}

export async function listValidationRuns(input: { userId: string; strategyId?: string; limit?: number; includeInfrastructureErrors?: boolean }) {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const rows = await prisma.validationRun.findMany({
    where: { userId: input.userId, ...(input.strategyId ? { strategyId: input.strategyId } : {}) },
    orderBy: { createdAt: "desc" },
    take: input.includeInfrastructureErrors === false ? Math.min(limit * 4, 500) : limit,
  });
  return input.includeInfrastructureErrors === false
    ? rows.filter((run) => !isInfrastructureValidationError(run)).slice(0, limit)
    : rows;
}
