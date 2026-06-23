CREATE TYPE "IncidentSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

CREATE TABLE "Incident" (
  "id" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "severity" "IncidentSeverity" NOT NULL,
  "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
  "source" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "context" JSONB NOT NULL DEFAULT '{}',
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,
  CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Incident_status_lastSeenAt_idx" ON "Incident"("status", "lastSeenAt");
CREATE INDEX "Incident_dedupeKey_status_idx" ON "Incident"("dedupeKey", "status");
