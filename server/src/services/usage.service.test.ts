import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createCustomer } from './customer.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import { createSubscription } from './subscription.service';
import {
  aggregateUsageByMetric,
  getCurrentPeriodUsageSummary,
  listUsageEvents,
  recordUsageEvent,
  sumUsageForMetric,
} from './usage.service';

async function resetDb() {
  await prisma.usageEvent.deleteMany();
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.product.deleteMany();
  await prisma.organization.deleteMany();
}

async function makeOrg(name: string) {
  return prisma.organization.create({
    data: { name, slug: name.toLowerCase().replace(/\s+/g, '-') },
  });
}

async function makeUsageSubscription(organizationId: string, metric = 'api_calls') {
  const email = `${organizationId}-${Math.random().toString(36).slice(2)}@example.com`;
  const customer = await createCustomer(organizationId, { name: 'Jane Doe', email });
  const product = await createProduct(organizationId, { name: 'Metered product' });
  const plan = await createPlan(organizationId, {
    productId: product.id,
    name: 'Metered API',
    pricingModel: 'USAGE',
    interval: 'MONTH',
    currency: 'usd',
    usageMetric: metric,
    usageUnitAmount: 2,
  });
  const subscription = await createSubscription(organizationId, {
    customerId: customer.id,
    planId: plan.id,
  });
  return { customer, plan, subscription };
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('recordUsageEvent', () => {
  it('records a usage event, attributing it to the subscription customer', async () => {
    const org = await makeOrg('Acme');
    const { customer, subscription } = await makeUsageSubscription(org.id);

    const event = await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 42,
    });

    expect(event.customerId).toBe(customer.id);
    expect(event.subscriptionId).toBe(subscription.id);
    expect(event.metric).toBe('api_calls');
    expect(event.quantity).toBe(42);
  });

  it('defaults timestamp to now when omitted', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    const before = new Date();

    const event = await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 1,
    });

    expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('accepts a backdated timestamp for late-reported usage', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const event = await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 1,
      timestamp: yesterday,
    });

    expect(event.timestamp.getTime()).toBe(yesterday.getTime());
  });

  it('throws a 404 for a subscription belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const { subscription } = await makeUsageSubscription(orgB.id);

    await expect(
      recordUsageEvent(orgA.id, {
        subscriptionId: subscription.id,
        metric: 'api_calls',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('throws a 400 for a canceled subscription', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELED' },
    });

    await expect(
      recordUsageEvent(org.id, {
        subscriptionId: subscription.id,
        metric: 'api_calls',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('accepts the same idempotency key for two different subscriptions', async () => {
    const org = await makeOrg('Acme');
    const first = await makeUsageSubscription(org.id, 'api_calls');
    const second = await makeUsageSubscription(org.id, 'api_calls');

    await recordUsageEvent(org.id, {
      subscriptionId: first.subscription.id,
      metric: 'api_calls',
      quantity: 1,
      idempotencyKey: 'shared-key',
    });

    const event = await recordUsageEvent(org.id, {
      subscriptionId: second.subscription.id,
      metric: 'api_calls',
      quantity: 1,
      idempotencyKey: 'shared-key',
    });

    expect(event.subscriptionId).toBe(second.subscription.id);
  });

  it('rejects a duplicate idempotency key for the same subscription with a 409', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 1,
      idempotencyKey: 'retry-key',
    });

    await expect(
      recordUsageEvent(org.id, {
        subscriptionId: subscription.id,
        metric: 'api_calls',
        quantity: 999,
        idempotencyKey: 'retry-key',
      }),
    ).rejects.toMatchObject({ status: 409 });

    const events = await listUsageEvents(org.id, { subscriptionId: subscription.id });
    expect(events).toHaveLength(1);
  });

  it('allows repeated events without an idempotency key', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);

    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 1,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 1,
    });

    const events = await listUsageEvents(org.id, { subscriptionId: subscription.id });
    expect(events).toHaveLength(2);
  });
});

describe('listUsageEvents', () => {
  it('filters by metric', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 1,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'storage_gb',
      quantity: 5,
    });

    const events = await listUsageEvents(org.id, { metric: 'storage_gb' });

    expect(events).toHaveLength(1);
    expect(events[0]?.metric).toBe('storage_gb');
  });

  it('filters by a from/to timestamp range', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const now = new Date();
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 1,
      timestamp: twoDaysAgo,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 2,
      timestamp: now,
    });

    const recent = await listUsageEvents(org.id, {
      from: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    expect(recent).toHaveLength(1);
    expect(recent[0]?.quantity).toBe(2);
  });

  it('only returns events for the given organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const a = await makeUsageSubscription(orgA.id);
    const b = await makeUsageSubscription(orgB.id);
    await recordUsageEvent(orgA.id, {
      subscriptionId: a.subscription.id,
      metric: 'api_calls',
      quantity: 1,
    });
    await recordUsageEvent(orgB.id, {
      subscriptionId: b.subscription.id,
      metric: 'api_calls',
      quantity: 1,
    });

    const events = await listUsageEvents(orgA.id, {});

    expect(events).toHaveLength(1);
  });
});

describe('sumUsageForMetric', () => {
  it('sums quantity across multiple events for the same metric', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    const periodStart = subscription.currentPeriodStart;
    const periodEnd = subscription.currentPeriodEnd;
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 10,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 15,
    });

    const total = await sumUsageForMetric(
      org.id,
      subscription.id,
      'api_calls',
      periodStart,
      periodEnd,
    );

    expect(total).toBe(25);
  });

  it('excludes events for a different metric', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 10,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'storage_gb',
      quantity: 99,
    });

    const total = await sumUsageForMetric(
      org.id,
      subscription.id,
      'api_calls',
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd,
    );

    expect(total).toBe(10);
  });

  it('excludes an event exactly at the period end boundary (half-open interval)', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 10,
      timestamp: subscription.currentPeriodEnd,
    });

    const total = await sumUsageForMetric(
      org.id,
      subscription.id,
      'api_calls',
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd,
    );

    expect(total).toBe(0);
  });

  it('includes an event exactly at the period start boundary', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 10,
      timestamp: subscription.currentPeriodStart,
    });

    const total = await sumUsageForMetric(
      org.id,
      subscription.id,
      'api_calls',
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd,
    );

    expect(total).toBe(10);
  });

  it('returns 0 when no usage was recorded', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);

    const total = await sumUsageForMetric(
      org.id,
      subscription.id,
      'api_calls',
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd,
    );

    expect(total).toBe(0);
  });
});

describe('aggregateUsageByMetric', () => {
  it('groups and sums usage per metric, sorted by metric name', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'storage_gb',
      quantity: 5,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 10,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 20,
    });

    const usage = await aggregateUsageByMetric(
      org.id,
      subscription.id,
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd,
    );

    expect(usage).toEqual([
      { metric: 'api_calls', quantity: 30 },
      { metric: 'storage_gb', quantity: 5 },
    ]);
  });

  it('returns an empty array when no usage was recorded', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);

    const usage = await aggregateUsageByMetric(
      org.id,
      subscription.id,
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd,
    );

    expect(usage).toEqual([]);
  });
});

describe('getCurrentPeriodUsageSummary', () => {
  it('summarizes usage for the subscription current period', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeUsageSubscription(org.id);
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 7,
    });

    const summary = await getCurrentPeriodUsageSummary(org.id, subscription.id);

    expect(summary.subscriptionId).toBe(subscription.id);
    expect(summary.usage).toEqual([{ metric: 'api_calls', quantity: 7 }]);
  });

  it('throws a 404 for a subscription belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const { subscription } = await makeUsageSubscription(orgB.id);

    await expect(getCurrentPeriodUsageSummary(orgA.id, subscription.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});
