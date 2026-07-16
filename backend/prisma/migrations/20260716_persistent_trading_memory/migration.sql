CREATE TABLE "TradingMemory" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tradeId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "direction" "TradeDirection" NOT NULL,
  "strategyId" TEXT,
  "strategyName" TEXT,
  "source" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "profit" DOUBLE PRECISION NOT NULL,
  "rMultiple" DOUBLE PRECISION,
  "aiDecision" TEXT,
  "aiConfidence" DOUBLE PRECISION,
  "marketRegime" TEXT,
  "newsRisk" TEXT,
  "closeReason" TEXT,
  "lesson" TEXT NOT NULL,
  "mistakes" JSONB NOT NULL DEFAULT '[]',
  "strengths" JSONB NOT NULL DEFAULT '[]',
  "context" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TradingMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TradingMemory_tradeId_key" ON "TradingMemory"("tradeId");
CREATE INDEX "TradingMemory_userId_symbol_createdAt_idx" ON "TradingMemory"("userId", "symbol", "createdAt");
CREATE INDEX "TradingMemory_userId_strategyId_createdAt_idx" ON "TradingMemory"("userId", "strategyId", "createdAt");
CREATE INDEX "TradingMemory_userId_outcome_createdAt_idx" ON "TradingMemory"("userId", "outcome", "createdAt");

ALTER TABLE "TradingMemory"
  ADD CONSTRAINT "TradingMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TradingMemory"
  ADD CONSTRAINT "TradingMemory_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
