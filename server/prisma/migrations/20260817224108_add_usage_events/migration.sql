-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "usage_events_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "usage_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "usage_events_organizationId_idx" ON "usage_events"("organizationId");

-- CreateIndex
CREATE INDEX "usage_events_customerId_idx" ON "usage_events"("customerId");

-- CreateIndex
CREATE INDEX "usage_events_subscriptionId_metric_timestamp_idx" ON "usage_events"("subscriptionId", "metric", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_subscriptionId_idempotencyKey_key" ON "usage_events"("subscriptionId", "idempotencyKey");
