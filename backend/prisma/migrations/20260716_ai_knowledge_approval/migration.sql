ALTER TABLE "KnowledgeEntry"
  ADD COLUMN "approvalMethod" TEXT,
  ADD COLUMN "approvalDecision" TEXT,
  ADD COLUMN "approvalReason" TEXT,
  ADD COLUMN "approvalConfidence" DOUBLE PRECISION,
  ADD COLUMN "approvedBy" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3);

CREATE INDEX "KnowledgeEntry_approvalMethod_status_idx"
  ON "KnowledgeEntry"("approvalMethod", "status");
