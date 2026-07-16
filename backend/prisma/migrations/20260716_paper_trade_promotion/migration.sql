ALTER TABLE "PaperTrade"
  ADD COLUMN "promotedAt" TIMESTAMP(3),
  ADD COLUMN "promotedTradeId" TEXT;

CREATE UNIQUE INDEX "PaperTrade_promotedTradeId_key" ON "PaperTrade"("promotedTradeId");

ALTER TABLE "PaperTrade"
  ADD CONSTRAINT "PaperTrade_promotedTradeId_fkey"
  FOREIGN KEY ("promotedTradeId") REFERENCES "Trade"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
