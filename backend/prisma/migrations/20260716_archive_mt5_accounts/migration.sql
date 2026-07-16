-- Preserve account-linked trade history while allowing users to remove old
-- accounts from account management and erase their stored credentials.
ALTER TABLE "Mt5Account" ADD COLUMN "archivedAt" TIMESTAMP(3);
