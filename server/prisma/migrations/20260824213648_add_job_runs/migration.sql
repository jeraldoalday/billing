-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "attemptsMade" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "runAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "result" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "job_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "job_runs_organizationId_idx" ON "job_runs"("organizationId");

-- CreateIndex
CREATE INDEX "job_runs_organizationId_name_idx" ON "job_runs"("organizationId", "name");

-- CreateIndex
CREATE INDEX "job_runs_status_runAt_idx" ON "job_runs"("status", "runAt");
