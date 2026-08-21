-- CreateTable
CREATE TABLE "dunning_campaigns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attemptsMade" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "lastFailureCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "dunning_campaigns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "dunning_campaigns_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "dunning_campaigns_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dunning_attempts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "failureCode" TEXT,
    "paymentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dunning_attempts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "dunning_campaigns" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "secret" TEXT NOT NULL,
    "enabledEvents" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "webhook_endpoints_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attemptsMade" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "responseStatus" INTEGER,
    "error" TEXT,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "webhook_deliveries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "dunning_campaigns_invoiceId_key" ON "dunning_campaigns"("invoiceId");

-- CreateIndex
CREATE INDEX "dunning_campaigns_organizationId_idx" ON "dunning_campaigns"("organizationId");

-- CreateIndex
CREATE INDEX "dunning_campaigns_subscriptionId_idx" ON "dunning_campaigns"("subscriptionId");

-- CreateIndex
CREATE INDEX "dunning_campaigns_status_nextAttemptAt_idx" ON "dunning_campaigns"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "dunning_attempts_campaignId_idx" ON "dunning_attempts"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "dunning_attempts_campaignId_attemptNumber_key" ON "dunning_attempts"("campaignId", "attemptNumber");

-- CreateIndex
CREATE INDEX "webhook_endpoints_organizationId_idx" ON "webhook_endpoints"("organizationId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organizationId_idx" ON "webhook_deliveries"("organizationId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpointId_idx" ON "webhook_deliveries"("endpointId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");
