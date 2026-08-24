import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { RecordingWebhookTransport } from '../lib/webhookTransport';
import { createCoupon, redeemCoupon } from './coupon.service';
import { createCustomer } from './customer.service';
import { generateInvoice } from './invoice.service';
import { addPaymentMethod } from './payment.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import { recordUsageEvent } from './usage.service';
import { cancelSubscription, createSubscription } from './subscription.service';
import * as webhookService from './webhook.service';
import { runBillingCycle } from './billing.service';

// Card numbers whose last four digits drive src/lib/paymentGateway.ts's
// deterministic mock outcomes.
const CARD = {
  succeeds: '4242424242424242',
  hardDeclines: '4000000000000002',
};

const DEFAULT_RUN = { limit: 100, maxPeriodsPerSubscription: 12 };

async function resetDb() {
  await prisma.jobRun.deleteMany();
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.dunningAttempt.deleteMany();
  await prisma.dunningCampaign.deleteMany();
  await prisma.couponRedemption.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.paymentMethod.deleteMany();
  await prisma.usageEvent.deleteMany();
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
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Math.random().toString(36).slice(2, 8)}` },
  });
}

interface FixtureOptions {
  name?: string;
  cardNumber?: string | null;
  flatAmount?: number;
  interval?: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
  trialDays?: number;
}

// An organization with one customer subscribed to a $50/month plan, a card
// on file, and a billing period that is still open — the state every
// scenario in this file starts from and then moves the clock past.
async function makeFixture(options: FixtureOptions = {}) {
  const {
    name = 'Acme',
    cardNumber = CARD.succeeds,
    flatAmount = 5000,
    interval = 'MONTH',
    trialDays,
  } = options;

  const org = await makeOrg(name);
  const customer = await createCustomer(org.id, { name: 'Jane Doe', email: `jane@${org.slug}.test` });
  const product = await createProduct(org.id, { name: 'Pro product' });
  const plan = await createPlan(org.id, {
    productId: product.id,
    name: 'Pro Monthly',
    pricingModel: 'FLAT',
    interval,
    currency: 'usd',
    flatAmount,
  });
  const subscription = await createSubscription(org.id, {
    customerId: customer.id,
    planId: plan.id,
    trialDays,
  });

  if (cardNumber) {
    await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber,
      expMonth: 12,
      expYear: 2039,
      isDefault: true,
    });
  }

  return { org, customer, product, plan, subscription };
}

function justAfter(instant: Date, ms = 1_000): Date {
  return new Date(instant.getTime() + ms);
}

function monthsAfter(instant: Date, months: number): Date {
  const result = new Date(instant);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

const originalTransport = webhookService.getWebhookTransport();

beforeEach(resetDb);
afterEach(() => {
  webhookService.setWebhookTransport(originalTransport);
});
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('runBillingCycle', () => {
  it('invoices and collects the period that just closed, then rolls the subscription forward', async () => {
    const { org, subscription } = await makeFixture();
    const asOf = justAfter(subscription.currentPeriodEnd);

    const summary = await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf });

    expect(summary.subscriptionsConsidered).toBe(1);
    const [result] = summary.results;
    expect(result?.outcome).toBe('RENEWED');
    expect(result?.action).toBe('RENEW');
    expect(result?.periods).toHaveLength(1);
    expect(result?.periods[0]).toMatchObject({
      total: 5000,
      currency: 'usd',
      invoiceStatus: 'PAID',
      paymentStatus: 'SUCCEEDED',
      periodStart: subscription.currentPeriodStart.toISOString(),
      periodEnd: subscription.currentPeriodEnd.toISOString(),
    });

    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('ACTIVE');
    expect(updated.currentPeriodStart).toEqual(subscription.currentPeriodEnd);
    expect(updated.currentPeriodEnd.getTime()).toBeGreaterThan(subscription.currentPeriodEnd.getTime());
  });

  it('summarises what the run billed and collected', async () => {
    const { org, subscription } = await makeFixture();
    const asOf = justAfter(subscription.currentPeriodEnd);

    const summary = await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf });

    expect(summary.asOf).toBe(asOf.toISOString());
    expect(summary.totals).toMatchObject({
      renewed: 1,
      skipped: 0,
      errored: 0,
      invoicesBilled: 1,
      invoicesPaid: 1,
      paymentsFailed: 0,
      amountBilled: 5000,
      amountCollected: 5000,
    });
  });

  it('records a RENEWED audit event for the new period', async () => {
    const { org, subscription } = await makeFixture();

    await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf: justAfter(subscription.currentPeriodEnd) });

    const events = await prisma.subscriptionEvent.findMany({
      where: { subscriptionId: subscription.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.type)).toContain('RENEWED');
  });

  it('leaves a subscription whose period is still open alone', async () => {
    const { org, subscription } = await makeFixture();

    const summary = await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf: new Date() });

    expect(summary.subscriptionsConsidered).toBe(0);
    expect(summary.results).toEqual([]);
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(0);
  });

  it('does not bill the same period twice when the run is repeated', async () => {
    const { org, subscription } = await makeFixture();
    const asOf = justAfter(subscription.currentPeriodEnd);

    await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf });
    const second = await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf });

    expect(second.totals.invoicesBilled).toBe(0);
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(1);
  });

  it('bills only the named subscription when one is given', async () => {
    const { org, plan, subscription } = await makeFixture();
    const other = await createCustomer(org.id, { name: 'Other', email: 'other@acme.test' });
    const otherSubscription = await createSubscription(org.id, {
      customerId: other.id,
      planId: plan.id,
    });

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(subscription.currentPeriodEnd),
      subscriptionId: subscription.id,
    });

    expect(summary.results.map((result) => result.subscriptionId)).toEqual([subscription.id]);
    expect(await prisma.invoice.count({ where: { subscriptionId: otherSubscription.id } })).toBe(0);
  });

  it('never bills another organization s subscriptions', async () => {
    const acme = await makeFixture({ name: 'Acme' });
    const globex = await makeFixture({ name: 'Globex' });

    const summary = await runBillingCycle(acme.org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(acme.subscription.currentPeriodEnd),
    });

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]?.subscriptionId).toBe(acme.subscription.id);
    expect(await prisma.invoice.count({ where: { organizationId: globex.org.id } })).toBe(0);
  });
});

describe('catching up on missed periods', () => {
  it('bills one invoice per elapsed period, tiled without gaps', async () => {
    const { org, subscription } = await makeFixture();
    const asOf = justAfter(monthsAfter(subscription.currentPeriodEnd, 2));

    const summary = await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf });

    const [result] = summary.results;
    expect(result?.periods).toHaveLength(3);
    const boundaries = result?.periods.map((period) => [period.periodStart, period.periodEnd]) ?? [];
    expect(boundaries[0]?.[0]).toBe(subscription.currentPeriodStart.toISOString());
    expect(boundaries[0]?.[1]).toBe(boundaries[1]?.[0]);
    expect(boundaries[1]?.[1]).toBe(boundaries[2]?.[0]);
    expect(summary.totals.amountBilled).toBe(15000);
  });

  it('stops at the per-subscription period cap and catches up on the next run', async () => {
    const { org, subscription } = await makeFixture();
    const asOf = justAfter(monthsAfter(subscription.currentPeriodEnd, 4));

    const first = await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf, maxPeriodsPerSubscription: 2 });
    expect(first.results[0]?.periods).toHaveLength(2);

    const second = await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf, maxPeriodsPerSubscription: 2 });
    expect(second.results[0]?.periods).toHaveLength(2);
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(4);
  });

  it('reuses an invoice that was already generated for the closing period', async () => {
    const { org, subscription } = await makeFixture();
    const draft = await generateInvoice(org.id, { subscriptionId: subscription.id });

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(subscription.currentPeriodEnd),
    });

    expect(summary.results[0]?.periods[0]?.invoiceId).toBe(draft.id);
    expect(summary.results[0]?.periods[0]?.invoiceStatus).toBe('PAID');
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(1);
  });
});

describe('failed collection', () => {
  it('leaves the invoice open, opens dunning, and hands the subscription over', async () => {
    const { org, subscription } = await makeFixture({ cardNumber: CARD.hardDeclines });

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(subscription.currentPeriodEnd),
    });

    expect(summary.totals).toMatchObject({ invoicesBilled: 1, invoicesPaid: 0, paymentsFailed: 1 });
    expect(summary.results[0]?.periods[0]).toMatchObject({
      invoiceStatus: 'OPEN',
      paymentStatus: 'FAILED',
      failureCode: 'card_declined',
    });

    const campaign = await prisma.dunningCampaign.findFirstOrThrow({
      where: { subscriptionId: subscription.id },
    });
    expect(campaign.status).toBe('SCHEDULED');
    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('PAST_DUE');
  });

  it('leaves a past-due subscription to dunning instead of stacking another invoice', async () => {
    const { org, subscription } = await makeFixture({ cardNumber: CARD.hardDeclines });
    await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf: justAfter(subscription.currentPeriodEnd) });

    const later = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(monthsAfter(subscription.currentPeriodEnd, 2)),
    });

    expect(later.results[0]).toMatchObject({ outcome: 'SKIPPED', reason: 'awaiting_payment' });
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(1);
  });

  it('still advances the period so the customer is not billed for it again', async () => {
    const { org, subscription } = await makeFixture({ cardNumber: CARD.hardDeclines });

    await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf: justAfter(subscription.currentPeriodEnd) });

    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.currentPeriodStart).toEqual(subscription.currentPeriodEnd);
  });

  it('chases a customer with no card on file through dunning', async () => {
    const { org, subscription } = await makeFixture({ cardNumber: null });

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(subscription.currentPeriodEnd),
    });

    expect(summary.results[0]?.periods[0]).toMatchObject({
      invoiceStatus: 'OPEN',
      paymentStatus: 'FAILED',
      paymentId: null,
      failureCode: 'no_payment_method',
    });
    const campaign = await prisma.dunningCampaign.findFirstOrThrow({
      where: { subscriptionId: subscription.id },
    });
    expect(campaign.lastFailureCode).toBe('no_payment_method');
    expect(await prisma.payment.count({ where: { organizationId: org.id } })).toBe(0);
  });
});

describe('trials', () => {
  it('converts a trial that has run out without invoicing the trial period', async () => {
    const { org, subscription } = await makeFixture({ trialDays: 14 });
    expect(subscription.status).toBe('TRIALING');

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(subscription.currentPeriodEnd),
    });

    expect(summary.results[0]).toMatchObject({ action: 'END_TRIAL', outcome: 'TRIAL_CONVERTED' });
    expect(summary.totals.invoicesBilled).toBe(0);

    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('ACTIVE');
    expect(updated.currentPeriodStart).toEqual(subscription.trialEnd);
    expect(updated.trialEnd).toEqual(subscription.trialEnd);
  });

  it('leaves a running trial alone', async () => {
    const { org, subscription } = await makeFixture({ trialDays: 14 });

    const summary = await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf: new Date() });

    expect(summary.subscriptionsConsidered).toBe(0);
    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('TRIALING');
  });

  it('bills the paid periods that elapsed since a trial ended long ago', async () => {
    const { org, subscription } = await makeFixture({ trialDays: 14 });
    const trialEnd = subscription.trialEnd ?? subscription.currentPeriodEnd;

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(monthsAfter(trialEnd, 2)),
    });

    expect(summary.results[0]?.outcome).toBe('RENEWED');
    expect(summary.results[0]?.periods).toHaveLength(2);
    expect(summary.results[0]?.periods[0]?.periodStart).toBe(trialEnd.toISOString());
  });

  it('cancels rather than converting a trial that was canceled during it', async () => {
    const { org, subscription } = await makeFixture({ trialDays: 14 });
    await cancelSubscription(org.id, subscription.id, { atPeriodEnd: true });

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(subscription.currentPeriodEnd),
    });

    expect(summary.results[0]?.outcome).toBe('CANCELED');
    expect(summary.totals.invoicesBilled).toBe(0);
    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('CANCELED');
  });
});

describe('scheduled cancellations', () => {
  it('bills the final period and then stops the subscription', async () => {
    const { org, subscription } = await makeFixture();
    await cancelSubscription(org.id, subscription.id, { atPeriodEnd: true });

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(subscription.currentPeriodEnd),
    });

    expect(summary.results[0]?.outcome).toBe('CANCELED');
    expect(summary.results[0]?.periods).toHaveLength(1);
    expect(summary.results[0]?.periods[0]?.invoiceStatus).toBe('PAID');

    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('CANCELED');
    expect(updated.canceledAt).not.toBeNull();
    // The date the customer was told keeps standing, rather than being
    // overwritten with the moment the runner got to it.
    expect(updated.cancelAt).toEqual(subscription.currentPeriodEnd);
    // And the period is not rolled forward into one nobody will pay for.
    expect(updated.currentPeriodEnd).toEqual(subscription.currentPeriodEnd);
  });

  it('does not keep billing a canceled subscription on later runs', async () => {
    const { org, subscription } = await makeFixture();
    await cancelSubscription(org.id, subscription.id, { atPeriodEnd: true });
    await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf: justAfter(subscription.currentPeriodEnd) });

    const later = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(monthsAfter(subscription.currentPeriodEnd, 3)),
    });

    expect(later.subscriptionsConsidered).toBe(0);
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(1);
  });

  it('leaves a cancellation booked for a future period alone', async () => {
    const { org, subscription } = await makeFixture();
    await cancelSubscription(org.id, subscription.id, { atPeriodEnd: true });

    const summary = await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf: new Date() });

    expect(summary.subscriptionsConsidered).toBe(0);
    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('ACTIVE');
  });
});

describe('what lands on the invoice', () => {
  it('bills metered usage recorded during the closing period', async () => {
    const org = await makeOrg('Metered');
    const customer = await createCustomer(org.id, { name: 'Jane', email: 'jane@metered.test' });
    const product = await createProduct(org.id, { name: 'API' });
    const plan = await createPlan(org.id, {
      productId: product.id,
      name: 'API usage',
      pricingModel: 'USAGE',
      interval: 'MONTH',
      currency: 'usd',
      usageMetric: 'api_calls',
      usageUnitAmount: 2,
    });
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
    await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2039,
      isDefault: true,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 1_500,
      timestamp: new Date(subscription.currentPeriodStart.getTime() + 60_000),
    });

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(subscription.currentPeriodEnd),
    });

    expect(summary.results[0]?.periods[0]?.total).toBe(3_000);
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { subscriptionId: subscription.id },
      include: { lineItems: true },
    });
    expect(invoice.lineItems.map((item) => item.type)).toEqual(['USAGE']);
  });

  it('settles a fully discounted period without touching the gateway or needing a card', async () => {
    const { org, subscription } = await makeFixture({ cardNumber: null });
    const coupon = await createCoupon(org.id, {
      code: 'FREEMONTH',
      type: 'PERCENT_OFF',
      percentOff: 100,
      duration: 'ONCE',
    });
    await redeemCoupon(org.id, subscription.id, { code: coupon.code });

    const summary = await runBillingCycle(org.id, {
      ...DEFAULT_RUN,
      asOf: justAfter(subscription.currentPeriodEnd),
    });

    expect(summary.results[0]?.periods[0]).toMatchObject({
      total: 0,
      invoiceStatus: 'PAID',
      paymentStatus: 'NOT_ATTEMPTED',
    });
    expect(await prisma.payment.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await prisma.dunningCampaign.count({ where: { organizationId: org.id } })).toBe(0);
  });
});

describe('events', () => {
  it('tells subscribers about the renewal', async () => {
    const { org, subscription } = await makeFixture();
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['subscription.renewed'],
    });

    await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf: justAfter(subscription.currentPeriodEnd) });

    expect(transport.requests).toHaveLength(1);
    const sent = JSON.parse(transport.lastRequest?.payload ?? '{}');
    expect(sent).toMatchObject({
      type: 'subscription.renewed',
      data: { subscriptionId: subscription.id, customerId: subscription.customerId },
    });
  });

  it('tells subscribers about a cancellation the runner applied', async () => {
    const { org, subscription } = await makeFixture();
    await cancelSubscription(org.id, subscription.id, { atPeriodEnd: true });
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/cancellations',
      enabledEvents: ['subscription.canceled'],
    });

    await runBillingCycle(org.id, { ...DEFAULT_RUN, asOf: justAfter(subscription.currentPeriodEnd) });

    const sent = JSON.parse(transport.lastRequest?.payload ?? '{}');
    expect(sent).toMatchObject({
      type: 'subscription.canceled',
      data: { subscriptionId: subscription.id, reason: 'scheduled_cancellation' },
    });
  });
});
