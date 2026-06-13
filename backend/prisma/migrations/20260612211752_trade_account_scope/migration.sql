-- CreateIndex
CREATE INDEX "Trade_accountId_createdAt_idx" ON "Trade"("accountId", "createdAt");

-- Backfill: trades created before account stamping existed have no accountId.
-- Where the user has exactly one saved MT5 account, every historical trade
-- can only belong to it; users with several accounts keep NULL (unknowable).
UPDATE "Trade" t
SET "accountId" = a."id"
FROM "Mt5Account" a
WHERE t."accountId" IS NULL
  AND a."userId" = t."userId"
  AND (SELECT COUNT(*) FROM "Mt5Account" a2 WHERE a2."userId" = t."userId") = 1;
