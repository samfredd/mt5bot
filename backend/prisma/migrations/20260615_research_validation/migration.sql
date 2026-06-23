CREATE TYPE "ValidationStatus" AS ENUM ('PASSED', 'FAILED', 'INVALID', 'ERROR');

CREATE TABLE "ValidationRun" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "strategyId" TEXT,
  "candidateName" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "status" "ValidationStatus" NOT NULL,
  "trigger" TEXT NOT NULL,
  "trainStart" TIMESTAMP(3),
  "trainEnd" TIMESTAMP(3),
  "oosStart" TIMESTAMP(3),
  "oosEnd" TIMESTAMP(3),
  "instruments" JSONB NOT NULL DEFAULT '[]',
  "metrics" JSONB NOT NULL DEFAULT '{}',
  "gates" JSONB NOT NULL DEFAULT '{}',
  "rejectionReasons" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ValidationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ValidationRun_userId_createdAt_idx" ON "ValidationRun"("userId", "createdAt");
CREATE INDEX "ValidationRun_strategyId_createdAt_idx" ON "ValidationRun"("strategyId", "createdAt");

ALTER TABLE "ValidationRun"
  ADD CONSTRAINT "ValidationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ValidationRun"
  ADD CONSTRAINT "ValidationRun_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "PaperTradeStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

CREATE TABLE "PaperTrade" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "strategyId" TEXT,
  "symbol" TEXT NOT NULL,
  "direction" "TradeDirection" NOT NULL,
  "lots" DOUBLE PRECISION NOT NULL,
  "proposedEntry" DOUBLE PRECISION NOT NULL,
  "entryPrice" DOUBLE PRECISION NOT NULL,
  "stopLoss" DOUBLE PRECISION,
  "takeProfit" DOUBLE PRECISION,
  "expectedSpreadPoints" DOUBLE PRECISION NOT NULL,
  "expectedSlippagePoints" DOUBLE PRECISION NOT NULL,
  "expectedCommission" DOUBLE PRECISION NOT NULL,
  "instrumentSpec" JSONB NOT NULL,
  "marketSnapshot" JSONB NOT NULL DEFAULT '{}',
  "explanation" JSONB NOT NULL DEFAULT '{}',
  "status" "PaperTradeStatus" NOT NULL DEFAULT 'OPEN',
  "openedAt" TIMESTAMP(3) NOT NULL,
  "lastMarkedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "exitPrice" DOUBLE PRECISION,
  "exitReason" TEXT,
  "profit" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaperTrade_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaperTrade_userId_status_createdAt_idx" ON "PaperTrade"("userId", "status", "createdAt");
CREATE INDEX "PaperTrade_strategyId_createdAt_idx" ON "PaperTrade"("strategyId", "createdAt");

ALTER TABLE "PaperTrade"
  ADD CONSTRAINT "PaperTrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaperTrade"
  ADD CONSTRAINT "PaperTrade_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ExecutionComparison" (
  "id" TEXT NOT NULL,
  "tradeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "direction" "TradeDirection" NOT NULL,
  "expectedEntry" DOUBLE PRECISION NOT NULL,
  "actualEntry" DOUBLE PRECISION NOT NULL,
  "expectedExit" DOUBLE PRECISION,
  "actualExit" DOUBLE PRECISION,
  "expectedSpreadPoints" DOUBLE PRECISION,
  "actualSpreadPoints" DOUBLE PRECISION,
  "expectedSlippagePoints" DOUBLE PRECISION,
  "entrySlippage" DOUBLE PRECISION NOT NULL,
  "exitSlippage" DOUBLE PRECISION,
  "entryVariancePct" DOUBLE PRECISION NOT NULL,
  "exitVariancePct" DOUBLE PRECISION,
  "requestedAt" TIMESTAMP(3) NOT NULL,
  "filledAt" TIMESTAMP(3),
  "latencyMs" INTEGER,
  "expectedPnl" DOUBLE PRECISION,
  "actualPnl" DOUBLE PRECISION,
  "pnlVariance" DOUBLE PRECISION,
  "pnlVariancePct" DOUBLE PRECISION,
  "attributionConfidence" DOUBLE PRECISION,
  "attributionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExecutionComparison_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionComparison_tradeId_key" ON "ExecutionComparison"("tradeId");
CREATE INDEX "ExecutionComparison_userId_createdAt_idx" ON "ExecutionComparison"("userId", "createdAt");

ALTER TABLE "ExecutionComparison"
  ADD CONSTRAINT "ExecutionComparison_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExecutionComparison"
  ADD CONSTRAINT "ExecutionComparison_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiskSettings"
  ADD COLUMN "maxCurrencyExposurePct" DOUBLE PRECISION NOT NULL DEFAULT 600,
  ADD COLUMN "maxCorrelatedExposurePct" DOUBLE PRECISION NOT NULL DEFAULT 600,
  ADD COLUMN "autoFlattenNewsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autoFlattenLeadMin" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "autoFlattenMinimumImpact" "NewsImpact" NOT NULL DEFAULT 'HIGH',
  ADD COLUMN "autoFlattenSymbols" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "Trade"
  ADD COLUMN "attributionConfidence" DOUBLE PRECISION,
  ADD COLUMN "attributionReason" TEXT,
  ADD COLUMN "brokerExitPrice" DOUBLE PRECISION;

CREATE TABLE "TradeJournalEntry" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tradeId" TEXT NOT NULL,
  "notes" TEXT NOT NULL,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "lessons" TEXT NOT NULL,
  "rating" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TradeJournalEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TradeJournalEntry_tradeId_key" ON "TradeJournalEntry"("tradeId");
CREATE UNIQUE INDEX "TradeJournalEntry_userId_tradeId_key" ON "TradeJournalEntry"("userId", "tradeId");
CREATE INDEX "TradeJournalEntry_userId_updatedAt_idx" ON "TradeJournalEntry"("userId", "updatedAt");

ALTER TABLE "TradeJournalEntry"
  ADD CONSTRAINT "TradeJournalEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TradeJournalEntry"
  ADD CONSTRAINT "TradeJournalEntry_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
