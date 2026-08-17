import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import * as subscriptionService from './subscription.service';
import type { ListUsageEventsQuery, RecordUsageEventInput } from '../validators/usage';

async function assertIdempotencyKeyAvailable(subscriptionId: string, idempotencyKey: string) {
  const existing = await prisma.usageEvent.findUnique({
    where: { subscriptionId_idempotencyKey: { subscriptionId, idempotencyKey } },
  });
  if (existing) {
    throw ApiError.conflict(
      'A usage event with this idempotency key was already recorded for this subscription',
    );
  }
}

// Records one unit-of-usage event against a subscription. The subscription
// lookup is org-scoped (404s for another org's subscription, same as every
// other resource in this codebase), and the event's customerId is derived
// from the subscription rather than trusted from the request body, so a
// usage event can never be attributed to the wrong customer.
export async function recordUsageEvent(organizationId: string, input: RecordUsageEventInput) {
  const subscription = await subscriptionService.getSubscription(
    organizationId,
    input.subscriptionId,
  );

  if (subscription.status === 'CANCELED') {
    throw ApiError.badRequest('Cannot record usage for a canceled subscription');
  }

  if (input.idempotencyKey) {
    await assertIdempotencyKeyAvailable(subscription.id, input.idempotencyKey);
  }

  return prisma.usageEvent.create({
    data: {
      organizationId,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      metric: input.metric,
      quantity: input.quantity,
      timestamp: input.timestamp ?? new Date(),
      idempotencyKey: input.idempotencyKey,
    },
  });
}

export async function listUsageEvents(organizationId: string, query: ListUsageEventsQuery) {
  return prisma.usageEvent.findMany({
    where: {
      organizationId,
      subscriptionId: query.subscriptionId,
      customerId: query.customerId,
      metric: query.metric,
      timestamp: {
        gte: query.from,
        lte: query.to,
      },
    },
    orderBy: { timestamp: 'desc' },
  });
}

export interface MetricUsage {
  metric: string;
  quantity: number;
}

// Sums usage quantity per metric for a subscription within [periodStart,
// periodEnd) — the half-open interval matches how billing periods are
// treated everywhere else in this codebase (a period's end instant belongs
// to the *next* period, not this one), so usage reported exactly at
// periodEnd is never double-counted across two invoices.
export async function aggregateUsageByMetric(
  organizationId: string,
  subscriptionId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<MetricUsage[]> {
  const grouped = await prisma.usageEvent.groupBy({
    by: ['metric'],
    where: {
      organizationId,
      subscriptionId,
      timestamp: { gte: periodStart, lt: periodEnd },
    },
    _sum: { quantity: true },
  });

  return grouped
    .map((row) => ({ metric: row.metric, quantity: row._sum.quantity ?? 0 }))
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

// Sums usage quantity for one specific metric within [periodStart,
// periodEnd) — what src/services/invoice.service.ts calls to price a
// USAGE/TIERED plan's line item, since a plan bills exactly one metric.
export async function sumUsageForMetric(
  organizationId: string,
  subscriptionId: string,
  metric: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const result = await prisma.usageEvent.aggregate({
    where: {
      organizationId,
      subscriptionId,
      metric,
      timestamp: { gte: periodStart, lt: periodEnd },
    },
    _sum: { quantity: true },
  });

  return result._sum.quantity ?? 0;
}

// A read-only summary of the subscription's current billing period, grouped
// by metric, for previewing what an invoice would charge before actually
// generating one.
export async function getCurrentPeriodUsageSummary(organizationId: string, subscriptionId: string) {
  const subscription = await subscriptionService.getSubscription(organizationId, subscriptionId);

  const usage = await aggregateUsageByMetric(
    organizationId,
    subscription.id,
    subscription.currentPeriodStart,
    subscription.currentPeriodEnd,
  );

  return {
    subscriptionId: subscription.id,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
    usage,
  };
}
