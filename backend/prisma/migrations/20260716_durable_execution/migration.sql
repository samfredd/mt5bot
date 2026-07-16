ALTER TYPE "TradeStatus" ADD VALUE IF NOT EXISTS 'SUBMITTING';
ALTER TYPE "TradeStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_FILLED';
ALTER TYPE "TradeStatus" ADD VALUE IF NOT EXISTS 'UNKNOWN';

CREATE TYPE "OrderIntentStatus" AS ENUM ('PREPARED', 'SUBMITTING', 'PLACED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'UNKNOWN', 'CANCELLED');

CREATE TABLE "OrderIntent" (
  "id" TEXT NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "tradeId" TEXT NOT NULL,
  "marketKey" TEXT NOT NULL,
  "expectedLogin" TEXT NOT NULL,
  "expectedServer" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "status" "OrderIntentStatus" NOT NULL DEFAULT 'PREPARED',
  "requestedVolume" DOUBLE PRECISION NOT NULL,
  "filledVolume" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "brokerOrderId" TEXT,
  "brokerDealId" TEXT,
  "brokerPositionId" TEXT,
  "retcode" INTEGER,
  "error" TEXT,
  "submittedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketReservation" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "marketKey" TEXT NOT NULL,
  "intentId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "MarketReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderIntent_clientOrderId_key" ON "OrderIntent"("clientOrderId");
CREATE UNIQUE INDEX "OrderIntent_tradeId_key" ON "OrderIntent"("tradeId");
CREATE INDEX "OrderIntent_status_updatedAt_idx" ON "OrderIntent"("status", "updatedAt");
CREATE INDEX "OrderIntent_accountId_marketKey_status_idx" ON "OrderIntent"("accountId", "marketKey", "status");
CREATE UNIQUE INDEX "MarketReservation_intentId_key" ON "MarketReservation"("intentId");
CREATE UNIQUE INDEX "MarketReservation_accountId_marketKey_key" ON "MarketReservation"("accountId", "marketKey");
CREATE INDEX "MarketReservation_status_expiresAt_idx" ON "MarketReservation"("status", "expiresAt");

ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Mt5Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketReservation" ADD CONSTRAINT "MarketReservation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Mt5Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketReservation" ADD CONSTRAINT "MarketReservation_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "OrderIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
