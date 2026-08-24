import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from './lib/prisma';
import { createCustomer } from './services/customer.service';
import { addPaymentMethod } from './services/payment.service';
import { createPlan } from './services/plan.service';
import { createProduct } from './services/product.service';
import { createSubscription } from './services/subscription.service';
import { listJobRuns, resetJobQueue } from './services/job.service';
import { createWorker } from './worker';

const CARD_THAT_SUCCEEDS = '4242424242424242';

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

// An organization whose only subscription has a closed billing period and a
// card on file, so one pass of the worker has real work to do.
async function makeDueSubscription(name = 'Acme') {
  const org = await prisma.organization.create({
    data: { name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}` },
  });
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
  await addPaymentMethod(org.id, {
    customerId: customer.id,
    cardNumber: CARD_THAT_SUCCEEDS,
    expMonth: 12,
    expYear: 2039,
    isDefault: true,
  });

  return { org, subscription, afterPeriod: new Date(subscription.currentPeriodEnd.getTime() + 1_000) };
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

describe('createWorker', () => {
  it('schedules every recurring sweep', () => {
    const worker = createWorker({
      billingIntervalMs: 900_000,
      dunningIntervalMs: 600_000,
      webhookRetryIntervalMs: 60_000,
    });

    expect(worker.scheduler.list().map((task) => task.name).sort()).toEqual([
      'billing.cycle',
      'dunning.sweep',
      'webhook.retry',
    ]);
    expect(worker.scheduler.get('dunning.sweep')?.intervalMs).toBe(600_000);
    expect(worker.scheduler.get('webhook.retry')?.intervalMs).toBe(60_000);
  });

  it('starts and stops both halves of the worker together', () => {
    const worker = createWorker();

    worker.start();
    expect(worker.isRunning()).toBe(true);
    expect(worker.queue.isPolling()).toBe(true);

    worker.stop();
    expect(worker.isRunning()).toBe(false);
    expect(worker.queue.isPolling()).toBe(false);
  });
});

describe('runOnce', () => {
  it('bills a subscription whose period has closed, end to end', async () => {
    const { org, subscription, afterPeriod } = await makeDueSubscription();
    const worker = createWorker();

    await worker.runOnce(afterPeriod);

    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: subscription.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.status).toBe('PAID');

    const renewed = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(renewed.currentPeriodStart).toEqual(subscription.currentPeriodEnd);

    const runs = await listJobRuns(org.id, { limit: 50 });
    expect(runs.map((run) => run.name).sort()).toEqual([
      'billing.cycle',
      'dunning.sweep',
      'webhook.retry',
    ]);
    expect(runs.every((run) => run.status === 'SUCCEEDED')).toBe(true);
  });

  it('sweeps every organization in one pass', async () => {
    const acme = await makeDueSubscription('Acme');
    const globex = await makeDueSubscription('Globex');
    const worker = createWorker();

    await worker.runOnce(acme.afterPeriod);

    expect(await prisma.invoice.count({ where: { organizationId: acme.org.id } })).toBe(1);
    expect(await prisma.invoice.count({ where: { organizationId: globex.org.id } })).toBe(1);
  });

  it('does nothing when no subscription is due', async () => {
    const { org, subscription } = await makeDueSubscription();
    const worker = createWorker();

    await worker.runOnce(new Date());

    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(0);
    const billing = await listJobRuns(org.id, { limit: 50, name: 'billing.cycle' });
    expect(JSON.parse(billing[0]?.result ?? '{}')).toMatchObject({ subscriptionsConsidered: 0 });
  });

  it('does not re-run a sweep before its interval has elapsed', async () => {
    const { org, afterPeriod } = await makeDueSubscription();
    const worker = createWorker({ billingIntervalMs: 900_000 });

    await worker.runOnce(afterPeriod);
    await worker.runOnce(new Date(afterPeriod.getTime() + 60_000));

    const runs = await listJobRuns(org.id, { limit: 50, name: 'billing.cycle' });
    expect(runs).toHaveLength(1);
  });

  it('runs the sweep again once its interval has elapsed', async () => {
    const { org, afterPeriod } = await makeDueSubscription();
    const worker = createWorker({ billingIntervalMs: 900_000 });

    await worker.runOnce(afterPeriod);
    await worker.runOnce(new Date(afterPeriod.getTime() + 900_000));

    const runs = await listJobRuns(org.id, { limit: 50, name: 'billing.cycle' });
    expect(runs).toHaveLength(2);
  });

  it('hands a declined renewal to dunning and retries it on a later pass', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Retry', slug: `retry-${Math.random().toString(36).slice(2, 8)}` },
    });
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
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    // A card the mock gateway always declines, so the renewal fails and the
    // recovery schedule takes the subscription over.
    await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: '4000000000000341',
      expMonth: 12,
      expYear: 2039,
      isDefault: true,
    });

    const worker = createWorker({ billingIntervalMs: 1_000, dunningIntervalMs: 1_000 });
    const afterPeriod = new Date(subscription.currentPeriodEnd.getTime() + 1_000);

    await worker.runOnce(afterPeriod);
    const afterFirstRun = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(afterFirstRun.status).toBe('PAST_DUE');

    // Two days later the first dunning retry is due.
    await worker.runOnce(new Date(afterPeriod.getTime() + 2 * 24 * 60 * 60 * 1000));

    const campaign = await prisma.dunningCampaign.findFirstOrThrow({
      where: { subscriptionId: subscription.id },
    });
    expect(campaign.attemptsMade).toBe(1);
    expect(campaign.lastFailureCode).toBe('insufficient_funds');
    const attempts = await prisma.dunningAttempt.findMany({ where: { campaignId: campaign.id } });
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(['FAILED']);
  });
});

describe('polling', () => {
  it('sweeps on its own timer once started', async () => {
    vi.useFakeTimers();
    try {
      const worker = createWorker({ tickMs: 100, billingIntervalMs: 1_000 });
      const enqueued = vi.spyOn(worker.scheduler, 'runDue');

      worker.start();
      await vi.advanceTimersByTimeAsync(300);

      expect(enqueued).toHaveBeenCalled();
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
