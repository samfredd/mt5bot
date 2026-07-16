CREATE TABLE "IntelligenceSource" (
  "id" TEXT NOT NULL, "slug" TEXT NOT NULL, "name" TEXT NOT NULL, "category" TEXT NOT NULL,
  "accessMethod" TEXT NOT NULL, "homepageUrl" TEXT, "feedUrl" TEXT, "enabled" BOOLEAN NOT NULL DEFAULT false,
  "approved" BOOLEAN NOT NULL DEFAULT false, "official" BOOLEAN NOT NULL DEFAULT false,
  "baseReliability" DOUBLE PRECISION NOT NULL DEFAULT 0.5, "reliabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "pollIntervalMin" INTEGER NOT NULL DEFAULT 60, "termsNote" TEXT, "healthStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0, "lastFetchedAt" TIMESTAMP(3), "nextFetchAt" TIMESTAMP(3),
  "lastError" TEXT, "rateLimitRemaining" INTEGER, "config" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntelligenceSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntelligenceSource_slug_key" ON "IntelligenceSource"("slug");
CREATE INDEX "IntelligenceSource_enabled_nextFetchAt_idx" ON "IntelligenceSource"("enabled", "nextFetchAt");
CREATE INDEX "IntelligenceSource_category_reliabilityScore_idx" ON "IntelligenceSource"("category", "reliabilityScore");

CREATE TABLE "IntelligenceStory" (
  "id" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "title" TEXT NOT NULL, "topic" TEXT NOT NULL, "summary" TEXT,
  "verificationStatus" TEXT NOT NULL DEFAULT 'UNCONFIRMED', "confirmationCount" INTEGER NOT NULL DEFAULT 0,
  "sourceCount" INTEGER NOT NULL DEFAULT 0, "relatedAssets" JSONB NOT NULL DEFAULT '[]', "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntelligenceStory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntelligenceStory_fingerprint_key" ON "IntelligenceStory"("fingerprint");
CREATE INDEX "IntelligenceStory_verificationStatus_lastSeenAt_idx" ON "IntelligenceStory"("verificationStatus", "lastSeenAt");

CREATE TABLE "IntelligenceItem" (
  "id" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "storyId" TEXT, "externalId" TEXT, "canonicalUrl" TEXT,
  "title" TEXT NOT NULL, "author" TEXT, "content" TEXT NOT NULL, "summary" TEXT, "kind" TEXT NOT NULL DEFAULT 'NEWS',
  "topic" TEXT NOT NULL DEFAULT 'OTHER', "factuality" TEXT NOT NULL DEFAULT 'REPORT', "verificationStatus" TEXT NOT NULL DEFAULT 'UNCONFIRMED',
  "sentiment" TEXT NOT NULL DEFAULT 'NEUTRAL', "urgency" TEXT NOT NULL DEFAULT 'NORMAL', "expectedImpact" TEXT NOT NULL DEFAULT 'LOW',
  "credibilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5, "relevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "noveltyScore" DOUBLE PRECISION NOT NULL DEFAULT 1, "communityMomentum" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "promptInjectionDetected" BOOLEAN NOT NULL DEFAULT false, "relatedAssets" JSONB NOT NULL DEFAULT '[]', "countries" JSONB NOT NULL DEFAULT '[]',
  "entities" JSONB NOT NULL DEFAULT '[]', "claims" JSONB NOT NULL DEFAULT '[]', "engagement" JSONB NOT NULL DEFAULT '{}',
  "raw" JSONB NOT NULL DEFAULT '{}', "contentHash" TEXT NOT NULL, "searchText" TEXT NOT NULL, "embedding" JSONB NOT NULL DEFAULT '[]',
  "publishedAt" TIMESTAMP(3), "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3), "approvedByUser" BOOLEAN NOT NULL DEFAULT false, "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntelligenceItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntelligenceItem_sourceId_contentHash_key" ON "IntelligenceItem"("sourceId", "contentHash");
CREATE INDEX "IntelligenceItem_storyId_publishedAt_idx" ON "IntelligenceItem"("storyId", "publishedAt");
CREATE INDEX "IntelligenceItem_verificationStatus_relevanceScore_idx" ON "IntelligenceItem"("verificationStatus", "relevanceScore");
CREATE INDEX "IntelligenceItem_kind_publishedAt_idx" ON "IntelligenceItem"("kind", "publishedAt");
CREATE INDEX "IntelligenceItem_search_idx" ON "IntelligenceItem" USING GIN (to_tsvector('english', "searchText"));

CREATE TABLE "IntelligenceClaim" (
  "id" TEXT NOT NULL, "storyId" TEXT NOT NULL, "itemId" TEXT NOT NULL, "claimHash" TEXT NOT NULL, "text" TEXT NOT NULL,
  "stance" TEXT NOT NULL DEFAULT 'SUPPORTS', "verificationStatus" TEXT NOT NULL DEFAULT 'UNCONFIRMED', "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "IntelligenceClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntelligenceClaim_itemId_claimHash_key" ON "IntelligenceClaim"("itemId", "claimHash");
CREATE INDEX "IntelligenceClaim_storyId_claimHash_idx" ON "IntelligenceClaim"("storyId", "claimHash");

CREATE TABLE "KnowledgeEntry" (
  "id" TEXT NOT NULL, "key" TEXT NOT NULL, "type" TEXT NOT NULL, "title" TEXT NOT NULL, "content" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5, "verificationStatus" TEXT NOT NULL DEFAULT 'UNCONFIRMED', "status" TEXT NOT NULL DEFAULT 'PENDING',
  "userApproved" BOOLEAN NOT NULL DEFAULT false, "provenance" JSONB NOT NULL DEFAULT '[]', "relatedAssets" JSONB NOT NULL DEFAULT '[]',
  "entities" JSONB NOT NULL DEFAULT '[]', "embedding" JSONB NOT NULL DEFAULT '[]', "currentVersion" INTEGER NOT NULL DEFAULT 1,
  "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3), "reviewAt" TIMESTAMP(3), "lastValidatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeEntry_key_key" ON "KnowledgeEntry"("key");
CREATE INDEX "KnowledgeEntry_status_reviewAt_idx" ON "KnowledgeEntry"("status", "reviewAt");
CREATE INDEX "KnowledgeEntry_type_updatedAt_idx" ON "KnowledgeEntry"("type", "updatedAt");
CREATE INDEX "KnowledgeEntry_search_idx" ON "KnowledgeEntry" USING GIN (to_tsvector('english', "title" || ' ' || "content"));

CREATE TABLE "KnowledgeVersion" (
  "id" TEXT NOT NULL, "knowledgeEntryId" TEXT NOT NULL, "version" INTEGER NOT NULL, "content" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL, "verificationStatus" TEXT NOT NULL, "changeReason" TEXT NOT NULL,
  "provenance" JSONB NOT NULL DEFAULT '[]', "changedBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeVersion_knowledgeEntryId_version_key" ON "KnowledgeVersion"("knowledgeEntryId", "version");

CREATE TABLE "IntelligenceIngestionRun" (
  "id" TEXT NOT NULL, "sourceId" TEXT, "jobType" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "fetchedCount" INTEGER NOT NULL DEFAULT 0, "storedCount" INTEGER NOT NULL DEFAULT 0, "duplicateCount" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0, "error" TEXT, "rateLimit" JSONB NOT NULL DEFAULT '{}', "detail" JSONB NOT NULL DEFAULT '{}',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3), CONSTRAINT "IntelligenceIngestionRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntelligenceIngestionRun_idempotencyKey_key" ON "IntelligenceIngestionRun"("idempotencyKey");
CREATE INDEX "IntelligenceIngestionRun_status_startedAt_idx" ON "IntelligenceIngestionRun"("status", "startedAt");
CREATE INDEX "IntelligenceIngestionRun_sourceId_startedAt_idx" ON "IntelligenceIngestionRun"("sourceId", "startedAt");

CREATE TABLE "ResearchBrief" (
  "id" TEXT NOT NULL, "type" TEXT NOT NULL, "periodStart" TIMESTAMP(3) NOT NULL, "periodEnd" TIMESTAMP(3) NOT NULL,
  "title" TEXT NOT NULL, "content" TEXT NOT NULL, "citations" JSONB NOT NULL DEFAULT '[]', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchBrief_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ResearchBrief_type_periodStart_periodEnd_key" ON "ResearchBrief"("type", "periodStart", "periodEnd");

ALTER TABLE "IntelligenceItem" ADD CONSTRAINT "IntelligenceItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "IntelligenceSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntelligenceItem" ADD CONSTRAINT "IntelligenceItem_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "IntelligenceStory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IntelligenceClaim" ADD CONSTRAINT "IntelligenceClaim_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "IntelligenceStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntelligenceClaim" ADD CONSTRAINT "IntelligenceClaim_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "IntelligenceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_knowledgeEntryId_fkey" FOREIGN KEY ("knowledgeEntryId") REFERENCES "KnowledgeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntelligenceIngestionRun" ADD CONSTRAINT "IntelligenceIngestionRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "IntelligenceSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
