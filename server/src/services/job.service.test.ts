import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import * as billingService from './billing.service';
import { createCustomer } from './customer.service';
import { addPaymentMethod } from './payment.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import { createSubscription } from './subscription.service';
import {
  describeQueue,
  enqueueJob,
  enqueueRecurringJobs,
  getJobQueue,
  getJobRun,
  listJobRuns,
  resetJobQueue,
  runDueJobs,
} from './job.service';

const CARD = {
  succeeds: '4242424242424242',
  hardDeclines: '4000000000000002',
};

const DEFAULT_ENQUEUE = { payload: {} } as const;
const DEFAULT_RUN = { limit: 25 };

async function resetDb() {
  await prisma.jobRun.deleteMany();
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.dunningAttempt.deleteMany();
  await prisma.dunningCampaign.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.paymentMethod.deleteMany();
  await prisma.invoiceLineItem.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.product.deleteMany();
  await prisma.organization.deleteMany();
}

async function makeOrg(name: string) {
  return prisma.organization.create({
    data: { name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}` },
  });
}

// A subscription with a card on file whose first billing period is already
// over, so a billing.cycle job run against it has real work to do.
async function makeDueSubscription(orgName: string, cardNumber: string | null = CARD.succeeds) {
  const org = await makeOrg(orgName);
  const customer = await createCustomer(org.id, { name: 'Jane', email: `jane@${org.slug}.test` });
  const product = await createProduct(org.id, { name: 'Pro' });
  const plan = await createPlan(org.id, {
    productId: product.id,
    name: 'Pro Monthly',
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency: 'usd',
    flatAmount: 5000,
  });
  const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });

  if (cardNumber) {
    await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber,
      expMonth: 12,
      expYear: 2039,
      isDefault: true,
    });
  }

  return { org, customer, plan, subscription };
}

function justAfter(instant: Date): Date {
  return new Date(instant.getTime() + 1_000);
}

beforeEach(async () => {
  resetJobQueue();
  await resetDb();
});
afterEach(resetJobQueue);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('the application queue', () => {
  it('knows how to run every job in the catalogue', () => {
    expect(describeQueue().registered).toEqual(['billing.cycle', 'dunning.sweep', 'webhook.retry']);
  });

  it('hands out the same queue until it is reset', () => {
    const queue = getJobQueue();

    expect(getJobQueue()).toBe(queue);
    resetJobQueue();
    expect(getJobQueue()).not.toBe(queue);
  });
});

describe('enqueueJob', () => {
  it('records a pending run scoped to the organization', async () => {
    const org = await makeOrg('Acme');

    const run = await enqueueJob(org.id, { name: 'billing.cycle', ...DEFAULT_ENQUEUE });

    expect(run).toMatchObject({
      organizationId: org.id,
      name: 'billing.cycle',
      status: 'PENDING',
      attemptsMade: 0,
      result: null,
      error: null,
    });
    expect(JSON.parse(run.payload)).toEqual({ organizationId: org.id });
  });

  it('takes the organization from the caller, not the payload', async () => {
    const org = await makeOrg('Acme');
    const other = await makeOrg('Globex');

    const run = await enqueueJob(org.id, {
      name: 'billing.cycle',
      payload: { limit: 5 },
    });

    expect(JSON.parse(run.payload).organizationId).toBe(org.id);
    expect(await listJobRuns(other.id, { limit: 50 })).toEqual([]);
  });

  it('carries an asOf through as an ISO string the row can hold', async () => {
    const org = await makeOrg('Acme');
    const asOf = new Date('2026-10-01T00:00:00.000Z');

    const run = await enqueueJob(org.id, { name: 'dunning.sweep', payload: { asOf } });

    expect(JSON.parse(run.payload).asOf).toBe('2026-10-01T00:00:00.000Z');
  });

  it('can schedule a run for later', async () => {
    const org = await makeOrg('Acme');
    const runAt = new Date(Date.now() + 3_600_000);

    const run = await enqueueJob(org.id, { name: 'billing.cycle', ...DEFAULT_ENQUEUE, runAt });

    expect(run.runAt.toISOString()).toBe(runAt.toISOString());
    expect((await runDueJobs(org.id, DEFAULT_RUN)).ran).toBe(0);
  });
});

describe('runDueJobs', () => {
  it('runs a billing cycle and records what it billed', async () => {
    const { org, subscription } = await makeDueSubscription('Acme');
    await enqueueJob(org.id, {
      name: 'billing.cycle',
      payload: { asOf: justAfter(subscription.currentPeriodEnd) },
    });

    const result = await runDueJobs(org.id, DEFAULT_RUN);

    expect(result.ran).toBe(1);
    const [run] = result.runs;
    expect(run?.status).toBe('SUCCEEDED');
    expect(run?.attemptsMade).toBe(1);
    expect(run?.startedAt).not.toBeNull();
    expect(run?.finishedAt).not.toBeNull();
    expect(JSON.parse(run?.result ?? '{}')).toMatchObject({
      subscriptionsConsidered: 1,
      renewed: 1,
      invoicesBilled: 1,
      invoicesPaid: 1,
      amountCollected: 5000,
    });
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(1);
  });

  it('never runs another organization s work', async () => {
    const acme = await makeDueSubscription('Acme');
    const globex = await makeDueSubscription('Globex');
    await enqueueJob(acme.org.id, {
      name: 'billing.cycle',
      payload: { asOf: justAfter(acme.subscription.currentPeriodEnd) },
    });
    await enqueueJob(globex.org.id, {
      name: 'billing.cycle',
      payload: { asOf: justAfter(globex.subscription.currentPeriodEnd) },
    });

    const result = await runDueJobs(acme.org.id, DEFAULT_RUN);

    expect(result.ran).toBe(1);
    expect(await prisma.invoice.count({ where: { organizationId: globex.org.id } })).toBe(0);
    const queued = await listJobRuns(globex.org.id, { limit: 50 });
    expect(queued[0]?.status).toBe('PENDING');
  });

  it('runs the dunning sweep against campaigns that have come due', async () => {
    const { org, subscription } = await makeDueSubscription('Acme', CARD.hardDeclines);
    // The failed collection opens a campaign scheduled a day out.
    await enqueueJob(org.id, {
      name: 'billing.cycle',
      payload: { asOf: justAfter(subscription.currentPeriodEnd) },
    });
    await runDueJobs(org.id, DEFAULT_RUN);

    const dayAfter = new Date(subscription.currentPeriodEnd.getTime() + 2 * 24 * 60 * 60 * 1000);
    await enqueueJob(org.id, { name: 'dunning.sweep', payload: { asOf: dayAfter } });
    const result = await runDueJobs(org.id, DEFAULT_RUN);

    const sweep = result.runs.find((run) => run.name === 'dunning.sweep');
    expect(sweep?.status).toBe('SUCCEEDED');
    expect(JSON.parse(sweep?.result ?? '{}')).toMatchObject({ campaignsRun: 1, stillScheduled: 1 });
  });

  it('runs the webhook retry sweep and reports what it delivered', async () => {
    const org = await makeOrg('Acme');
    await enqueueJob(org.id, { name: 'webhook.retry', ...DEFAULT_ENQUEUE });

    const result = await runDueJobs(org.id, DEFAULT_RUN);

    expect(JSON.parse(result.runs[0]?.result ?? '{}')).toEqual({
      attempted: 0,
      delivered: 0,
      pending: 0,
      failed: 0,
    });
  });

  it('treats a subscription that no longer exists as nothing to bill', async () => {
    const org = await makeOrg('Acme');
    await enqueueJob(org.id, {
      name: 'billing.cycle',
      payload: { subscriptionId: 'sub_does_not_exist' },
    });

    const result = await runDueJobs(org.id, DEFAULT_RUN);

    expect(result.runs[0]?.status).toBe('SUCCEEDED');
    expect(JSON.parse(result.runs[0]?.result ?? '{}')).toMatchObject({
      subscriptionsConsidered: 0,
      invoicesBilled: 0,
    });
  });

  it('records a failed attempt on the row and leaves the run pending for its retry', async () => {
    const org = await makeOrg('Acme');
    const failing = vi
      .spyOn(billingService, 'runBillingCycle')
      .mockRejectedValue(new Error('database is down'));

    try {
      await enqueueJob(org.id, { name: 'billing.cycle', ...DEFAULT_ENQUEUE });
      const result = await runDueJobs(org.id, DEFAULT_RUN);

      const [run] = result.runs;
      expect(run?.status).toBe('PENDING');
      expect(run?.attemptsMade).toBe(1);
      expect(run?.error).toBe('database is down');
      expect(run?.finishedAt).toBeNull();
      // Backed off rather than retried immediately, so a sweep against a
      // database that is still down doesn't spin.
      expect(run?.runAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      failing.mockRestore();
    }
  });

  it('gives up on a run whose attempts are spent', async () => {
    const org = await makeOrg('Acme');
    const failing = vi
      .spyOn(billingService, 'runBillingCycle')
      .mockRejectedValue(new Error('still down'));

    try {
      const queued = await enqueueJob(org.id, {
        name: 'billing.cycle',
        ...DEFAULT_ENQUEUE,
        maxAttempts: 1,
      });
      await runDueJobs(org.id, DEFAULT_RUN);

      const run = await getJobRun(org.id, queued.id);
      expect(run.status).toBe('FAILED');
      expect(run.attemptsMade).toBe(1);
      expect(run.finishedAt).not.toBeNull();
    } finally {
      failing.mockRestore();
    }
  });

  it('honours a limit on how much of the backlog one call takes', async () => {
    const org = await makeOrg('Acme');
    await enqueueJob(org.id, { name: 'webhook.retry', ...DEFAULT_ENQUEUE });
    await enqueueJob(org.id, { name: 'webhook.retry', ...DEFAULT_ENQUEUE });
    await enqueueJob(org.id, { name: 'webhook.retry', ...DEFAULT_ENQUEUE });

    const result = await runDueJobs(org.id, { limit: 2 });

    expect(result.ran).toBe(2);
    expect((await listJobRuns(org.id, { limit: 50, status: 'PENDING' })).length).toBe(1);
  });

  it('does not run a run that has already settled', async () => {
    const { org, subscription } = await makeDueSubscription('Acme');
    await enqueueJob(org.id, {
      name: 'billing.cycle',
      payload: { asOf: justAfter(subscription.currentPeriodEnd) },
    });

    await runDueJobs(org.id, DEFAULT_RUN);
    const second = await runDueJobs(org.id, DEFAULT_RUN);

    expect(second.ran).toBe(0);
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(1);
  });
});

describe('listJobRuns and getJobRun', () => {
  it('lists an organization s runs newest first, and filters them', async () => {
    const org = await makeOrg('Acme');
    await enqueueJob(org.id, { name: 'billing.cycle', ...DEFAULT_ENQUEUE });
    await enqueueJob(org.id, { name: 'webhook.retry', ...DEFAULT_ENQUEUE });
    await runDueJobs(org.id, DEFAULT_RUN);

    expect(await listJobRuns(org.id, { limit: 50 })).toHaveLength(2);
    expect(await listJobRuns(org.id, { limit: 50, name: 'webhook.retry' })).toHaveLength(1);
    expect(await listJobRuns(org.id, { limit: 50, status: 'SUCCEEDED' })).toHaveLength(2);
    expect(await listJobRuns(org.id, { limit: 1 })).toHaveLength(1);
  });

  it('404s a run belonging to another organization exactly like a missing one', async () => {
    const org = await makeOrg('Acme');
    const other = await makeOrg('Globex');
    const run = await enqueueJob(org.id, { name: 'billing.cycle', ...DEFAULT_ENQUEUE });

    await expect(getJobRun(other.id, run.id)).rejects.toMatchObject({ status: 404 });
    await expect(getJobRun(org.id, 'nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('enqueueRecurringJobs', () => {
  it('queues one job per organization', async () => {
    const acme = await makeOrg('Acme');
    const globex = await makeOrg('Globex');

    const enqueued = await enqueueRecurringJobs('billing.cycle');

    expect(enqueued).toHaveLength(2);
    expect(await listJobRuns(acme.id, { limit: 50 })).toHaveLength(1);
    expect(await listJobRuns(globex.id, { limit: 50 })).toHaveLength(1);
  });

  it('does not stack a second sweep on an organization that still has one waiting', async () => {
    const org = await makeOrg('Acme');

    await enqueueRecurringJobs('billing.cycle');
    const second = await enqueueRecurringJobs('billing.cycle');

    expect(second).toHaveLength(0);
    expect(await listJobRuns(org.id, { limit: 50 })).toHaveLength(1);
  });

  it('queues the next sweep once the previous one has settled', async () => {
    const org = await makeOrg('Acme');
    await enqueueRecurringJobs('webhook.retry');
    await runDueJobs(org.id, DEFAULT_RUN);

    const next = await enqueueRecurringJobs('webhook.retry');

    expect(next).toHaveLength(1);
    expect(await listJobRuns(org.id, { limit: 50 })).toHaveLength(2);
  });

  it('keeps each job name on its own schedule', async () => {
    const org = await makeOrg('Acme');

    await enqueueRecurringJobs('billing.cycle');
    await enqueueRecurringJobs('dunning.sweep');

    expect(await listJobRuns(org.id, { limit: 50 })).toHaveLength(2);
    expect(describeQueue().pending).toBe(2);
  });
});
