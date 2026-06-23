-- Enforce one Mt5Account row per (userId, login).
--
-- Before adding the unique index we must merge any duplicate rows that the
-- pre-fix register() race already produced (observed live on 2026-06-17: two
-- rows for login 5051867443 inserted at the same millisecond). Strategy: keep
-- the earliest-created row per (userId, login), re-point the duplicates' trades
-- onto it, then delete the duplicates. Without this step the CREATE UNIQUE
-- INDEX would fail on any account that still has duplicates.

-- Re-point trades from duplicate rows onto the kept (earliest) row.
UPDATE "Trade" t
SET "accountId" = r.keep_id
FROM (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY "userId", "login"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS keep_id
  FROM "Mt5Account"
) r
WHERE t."accountId" = r."id"
  AND r."id" <> r.keep_id;

-- Delete the now-orphaned duplicate rows.
DELETE FROM "Mt5Account" a
USING (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY "userId", "login"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS keep_id
  FROM "Mt5Account"
) r
WHERE a."id" = r."id"
  AND r."id" <> r.keep_id;

-- CreateIndex
CREATE UNIQUE INDEX "Mt5Account_userId_login_key" ON "Mt5Account"("userId", "login");
