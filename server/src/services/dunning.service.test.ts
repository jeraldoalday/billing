import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { RecordingWebhookTransport } from '../lib/webhookTransport';
import { MAX_DUNNING_ATTEMPTS } from '../domain/dunning';
import { createCustomer } from './customer.service';
import { finalizeInvoice, generateInvoice, getInvoice, markInvoicePaid, voidInvoice } from './invoice.service';
import { addPaymentMethod, chargeInvoice } from './payment.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import { cancelSubscription, createSubscription } from './subscription.service';
import * as webhookService from './webhook.service';
import {
  cancelDunning,
  getDunningCampaign,
  listDunningCampaigns,
  runDueDunning,
  runDunningAttempt,
  startDunning,
} from './dunning.service';

// Card numbers whose last four digits drive src/lib/paymentGateway.ts's
// deterministic mock outcomes.
const CARD = {
  succeeds: '4242424242424242',
  hardDeclines: '4000000000000002',
};

const DAY_MS = 24 * 60 * 60 * 1000;

async function resetDb() {
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
    data: { name, slug: name.toLowerCase().replace(/\s+/g, '-') },
  });
}

// An organization with a customer on a $50/month plan and one finalized,
// unpaid invoice — the state every dunning scenario starts from.
async function makeBillingFixture(name = 'Acme', cardNumber: string | null = CARD.hardDeclines) {
  const org = await makeOrg(name);
  const customer = await createCustomer(org.id, {
    name: 'Jane Doe',
    email: `jane@${org.slug}.test`,
  });
  const product = await createProduct(org.id, { name: 'Pro product' });
  const plan = await createPlan(org.id, {
    productId: product.id,
    name: 'Pro Monthly',
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency: 'usd',
    flatAmount: 5000,
  });
  const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
  const draft = await generateInvoice(org.id, { subscriptionId: subscription.id });
  const invoice = await finalizeInvoice(org.id, draft.id);

  if (cardNumber) {
    await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber,
      expMonth: 12,
      expYear: 2039,
      isDefault: true,
    });
  }

  return { org, customer, plan, subscription, invoice };
}

// Adds a new default card so a later retry hits a different mock outcome —
// how a real customer "fixes" a declined payment method. The old card is
// left in place (a Payment references it) but stops being the default, which
// is what dunning retries pick.
async function replaceCard(organizationId: string, customerId: string, cardNumber: string) {
  return addPaymentMethod(organizationId, {
    customerId,
    cardNumber,
    expMonth: 12,
    expYear: 2039,
    isDefault: true,
  });
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

describe('startDunning', () => {
  it('opens a campaign scheduled one day out and marks the subscription past due', async () => {
    const { org, invoice, subscription } = await makeBillingFixture();
    const now = new Date('2026-06-01T00:00:00.000Z');

    const campaign = await startDunning(org.id, invoice.id, { failureCode: 'card_declined', now });

    expect(campaign.status).toBe('SCHEDULED');
    expect(campaign.attemptsMade).toBe(0);
    expect(campaign.lastFailureCode).toBe('card_declined');
    expect(campaign.nextAttemptAt?.toISOString()).toBe('2026-06-02T00:00:00.000Z');

    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('PAST_DUE');
  });

  it('is opened automatically by a declined charge', async () => {
    const { org, invoice, customer } = await makeBillingFixture();
    const paymentMethod = await prisma.paymentMethod.findFirstOrThrow({
      where: { customerId: customer.id },
    });

    const payment = await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id });

    expect(payment.status).toBe('FAILED');
    const [campaign] = await listDunningCampaigns(org.id, {});
    expect(campaign?.invoiceId).toBe(invoice.id);
    expect(campaign?.lastFailureCode).toBe('card_declined');
  });

  it('does not restart the schedule when the same invoice fails again', async () => {
    const { org, invoice } = await makeBillingFixture();
    const first = await startDunning(org.id, invoice.id, {
      failureCode: 'card_declined',
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    const second = await startDunning(org.id, invoice.id, {
      failureCode: 'insufficient_funds',
      now: new Date('2026-06-05T00:00:00.000Z'),
    });

    expect(second.id).toBe(first.id);
    expect(second.startedAt.toISOString()).toBe(first.startedAt.toISOString());
    expect(second.nextAttemptAt?.toISOString()).toBe(first.nextAttemptAt?.toISOString());
    expect(second.lastFailureCode).toBe('insufficient_funds');
  });

  it('opens only one campaign when two declines race on the same invoice', async () => {
    // Both calls find no campaign before either writes, the way two
    // overlapping POST /invoices/:id/charge calls declining the same
    // invoice would. invoiceId's unique constraint is what actually stops
    // a second campaign; without the fallback onto the "already exists"
    // handling, the loser would throw instead of recording its failure
    // code against the campaign the winner just opened.
    const { org, invoice } = await makeBillingFixture();
    const now = new Date('2026-06-01T00:00:00.000Z');

    const results = await Promise.all([
      startDunning(org.id, invoice.id, { failureCode: 'card_declined', now }),
      startDunning(org.id, invoice.id, { failureCode: 'insufficient_funds', now }),
    ]);

    expect(results[0].id).toBe(results[1].id);
    expect(['card_declined', 'insufficient_funds']).toContain(results[0].lastFailureCode);

    const campaigns = await prisma.dunningCampaign.findMany({ where: { invoiceId: invoice.id } });
    expect(campaigns).toHaveLength(1);
  });

  it('refuses to dun an invoice that is not open', async () => {
    const { org, invoice } = await makeBillingFixture();
    await voidInvoice(org.id, invoice.id);

    await expect(startDunning(org.id, invoice.id)).rejects.toMatchObject({ status: 409 });
  });

  it('404s for another organization invoice', async () => {
    const { invoice } = await makeBillingFixture('Acme');
    const other = await makeOrg('Globex');

    await expect(startDunning(other.id, invoice.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('runDunningAttempt', () => {
  it('does nothing while the next retry is in the future', async () => {
    const { org, invoice } = await makeBillingFixture();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now });

    const result = await runDunningAttempt(org.id, campaign.id, {
      now: new Date(now.getTime() + DAY_MS / 2),
    });

    expect(result.outcome).toBeNull();
    expect(result.campaign.attemptsMade).toBe(0);
    await expect(prisma.dunningAttempt.count()).resolves.toBe(0);
  });

  it('retries anyway when forced', async () => {
    const { org, invoice } = await makeBillingFixture();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now });

    const result = await runDunningAttempt(org.id, campaign.id, { now, force: true });

    expect(result.outcome).toBe('FAILED');
    expect(result.campaign.attemptsMade).toBe(1);
    expect(result.campaign.nextAttemptAt?.toISOString()).toBe('2026-06-04T00:00:00.000Z');
  });

  it('records an attempt row per retry', async () => {
    const { org, invoice } = await makeBillingFixture();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now });

    await runDunningAttempt(org.id, campaign.id, { now: new Date(now.getTime() + DAY_MS) });

    const attempts = await prisma.dunningAttempt.findMany({ where: { campaignId: campaign.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNumber: 1, outcome: 'FAILED', failureCode: 'card_declined' });
    expect(attempts[0]?.paymentId).toBeTruthy();
  });

  it('recovers the campaign and the subscription when a retry succeeds', async () => {
    const { org, invoice, customer, subscription } = await makeBillingFixture();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now });
    await replaceCard(org.id, customer.id, CARD.succeeds);

    const result = await runDunningAttempt(org.id, campaign.id, {
      now: new Date(now.getTime() + DAY_MS),
    });

    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.campaign.status).toBe('RECOVERED');
    expect(result.campaign.attemptsMade).toBe(1);
    expect(result.campaign.resolvedAt).not.toBeNull();
    expect(result.campaign.nextAttemptAt).toBeNull();

    await expect(getInvoice(org.id, invoice.id)).resolves.toMatchObject({ status: 'PAID' });
    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('ACTIVE');
  });

  it('treats a customer with no payment method as a skipped attempt', async () => {
    const { org, invoice } = await makeBillingFixture('Acme', null);
    const now = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now });

    const result = await runDunningAttempt(org.id, campaign.id, {
      now: new Date(now.getTime() + DAY_MS),
    });

    expect(result.outcome).toBe('SKIPPED');
    expect(result.campaign.attemptsMade).toBe(1);
    expect(result.campaign.lastFailureCode).toBe('no_payment_method');
    await expect(prisma.payment.count()).resolves.toBe(0);
  });

  it('closes the campaign as soon as the invoice is paid with another card', async () => {
    const { org, invoice, customer, subscription } = await makeBillingFixture();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now });

    const paymentMethod = await replaceCard(org.id, customer.id, CARD.succeeds);
    await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id });

    // The campaign resolves on the payment, not on the next sweep, so the
    // customer isn't left past due with a settled invoice.
    const resolved = await getDunningCampaign(org.id, campaign.id);
    expect(resolved.status).toBe('RECOVERED');
    expect(resolved.attempts).toHaveLength(0);

    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('ACTIVE');

    await expect(
      runDunningAttempt(org.id, campaign.id, { now: new Date(now.getTime() + DAY_MS) }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('closes the campaign when the invoice is marked paid administratively', async () => {
    const { org, invoice, subscription } = await makeBillingFixture();
    const campaign = await startDunning(org.id, invoice.id);

    await markInvoicePaid(org.id, invoice.id);

    await expect(getDunningCampaign(org.id, campaign.id)).resolves.toMatchObject({
      status: 'RECOVERED',
    });
    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.status).toBe('ACTIVE');
  });

  it('emits a single recovery event when a retry settles the invoice', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const { org, invoice, customer } = await makeBillingFixture();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/dunning',
      enabledEvents: ['dunning.recovered'],
    });

    const now = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now });
    await replaceCard(org.id, customer.id, CARD.succeeds);
    await runDunningAttempt(org.id, campaign.id, { now: new Date(now.getTime() + DAY_MS) });

    expect(transport.requests).toHaveLength(1);
    await expect(
      prisma.subscriptionEvent.count({ where: { type: 'DUNNING_RECOVERED' } }),
    ).resolves.toBe(1);
  });

  it('calls the campaign off when the subscription was canceled meanwhile', async () => {
    const { org, invoice, subscription } = await makeBillingFixture();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now });
    await cancelSubscription(org.id, subscription.id, { atPeriodEnd: false });

    const result = await runDunningAttempt(org.id, campaign.id, {
      now: new Date(now.getTime() + DAY_MS),
    });

    expect(result.campaign.status).toBe('CANCELED');
    expect(result.outcome).toBeNull();
    await expect(prisma.payment.count()).resolves.toBe(0);
    await expect(getInvoice(org.id, invoice.id)).resolves.toMatchObject({ status: 'OPEN' });
  });

  it('calls the campaign off when the invoice was voided', async () => {
    const { org, invoice } = await makeBillingFixture();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now });
    await voidInvoice(org.id, invoice.id);

    const result = await runDunningAttempt(org.id, campaign.id, {
      now: new Date(now.getTime() + DAY_MS),
    });

    expect(result.campaign.status).toBe('CANCELED');
    expect(result.outcome).toBeNull();
  });

  it('rejects a retry on a campaign that already resolved', async () => {
    const { org, invoice } = await makeBillingFixture();
    const campaign = await startDunning(org.id, invoice.id);
    await cancelDunning(org.id, campaign.id);

    await expect(runDunningAttempt(org.id, campaign.id, { force: true })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('404s for another organization campaign', async () => {
    const { org, invoice } = await makeBillingFixture('Acme');
    const other = await makeOrg('Globex');
    const campaign = await startDunning(org.id, invoice.id);

    await expect(runDunningAttempt(other.id, campaign.id, { force: true })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('runDueDunning', () => {
  it('runs the day 1, 3, and 7 retries and then cancels the subscription', async () => {
    const { org, invoice, subscription } = await makeBillingFixture();
    const start = new Date('2026-06-01T00:00:00.000Z');
    await startDunning(org.id, invoice.id, { now: start });

    const dueDays = [1, 3, 7];
    for (const day of dueDays) {
      // eslint-disable-next-line no-await-in-loop -- each sweep must observe the previous one's state
      const [result] = await runDueDunning(org.id, {
        asOf: new Date(start.getTime() + day * DAY_MS),
        limit: 50,
      });
      expect(result?.outcome).toBe('FAILED');
    }

    const attempts = await prisma.dunningAttempt.findMany({ orderBy: { attemptNumber: 'asc' } });
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(attempts.map((attempt) => attempt.scheduledFor.toISOString())).toEqual([
      '2026-06-02T00:00:00.000Z',
      '2026-06-04T00:00:00.000Z',
      '2026-06-08T00:00:00.000Z',
    ]);

    const [campaign] = await listDunningCampaigns(org.id, {});
    expect(campaign?.status).toBe('EXHAUSTED');
    expect(campaign?.attemptsMade).toBe(MAX_DUNNING_ATTEMPTS);
    expect(campaign?.nextAttemptAt).toBeNull();

    const canceled = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.canceledAt).not.toBeNull();

    // The debt itself survives the cancellation — it is still genuinely owed.
    await expect(getInvoice(org.id, invoice.id)).resolves.toMatchObject({ status: 'OPEN' });
  });

  it('picks up nothing before the first retry is due', async () => {
    const { org, invoice } = await makeBillingFixture();
    const start = new Date('2026-06-01T00:00:00.000Z');
    await startDunning(org.id, invoice.id, { now: start });

    await expect(
      runDueDunning(org.id, { asOf: new Date(start.getTime() + DAY_MS / 2), limit: 50 }),
    ).resolves.toHaveLength(0);
  });

  it('respects the sweep limit', async () => {
    const org = await makeOrg('Acme');
    const product = await createProduct(org.id, { name: 'Pro product' });
    const plan = await createPlan(org.id, {
      productId: product.id,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 5000,
    });
    const start = new Date('2026-06-01T00:00:00.000Z');

    for (const index of [0, 1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- fixtures depend on sequential invoice numbering
      const customer = await createCustomer(org.id, {
        name: `Customer ${index}`,
        email: `customer-${index}@acme.test`,
      });
      // eslint-disable-next-line no-await-in-loop -- see above
      const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
      // eslint-disable-next-line no-await-in-loop -- see above
      const draft = await generateInvoice(org.id, { subscriptionId: subscription.id });
      // eslint-disable-next-line no-await-in-loop -- see above
      const invoice = await finalizeInvoice(org.id, draft.id);
      // eslint-disable-next-line no-await-in-loop -- see above
      await startDunning(org.id, invoice.id, { now: start });
    }

    const results = await runDueDunning(org.id, {
      asOf: new Date(start.getTime() + DAY_MS),
      limit: 2,
    });

    expect(results).toHaveLength(2);
  });

  it('never touches another organization campaigns', async () => {
    const { org, invoice } = await makeBillingFixture('Acme');
    const other = await makeOrg('Globex');
    const start = new Date('2026-06-01T00:00:00.000Z');
    await startDunning(org.id, invoice.id, { now: start });

    await expect(
      runDueDunning(other.id, { asOf: new Date(start.getTime() + DAY_MS), limit: 50 }),
    ).resolves.toHaveLength(0);
  });
});

describe('dunning webhook events', () => {
  it('emits the campaign lifecycle to a subscribed endpoint', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const { org, invoice, customer } = await makeBillingFixture();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/dunning',
      enabledEvents: ['dunning.*'],
    });

    const start = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now: start });
    await runDunningAttempt(org.id, campaign.id, { now: new Date(start.getTime() + DAY_MS) });
    await replaceCard(org.id, customer.id, CARD.succeeds);
    await runDunningAttempt(org.id, campaign.id, { now: new Date(start.getTime() + 3 * DAY_MS) });

    const types = transport.requests.map(
      (request) => (JSON.parse(request.payload) as { type: string }).type,
    );
    expect(types).toEqual(['dunning.started', 'dunning.attempt_failed', 'dunning.recovered']);
  });

  it('emits dunning.exhausted and subscription.canceled when the budget runs out', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const { org, invoice } = await makeBillingFixture();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/all',
      enabledEvents: ['dunning.exhausted', 'subscription.canceled'],
    });

    const start = new Date('2026-06-01T00:00:00.000Z');
    await startDunning(org.id, invoice.id, { now: start });
    for (const day of [1, 3, 7]) {
      // eslint-disable-next-line no-await-in-loop -- each sweep must observe the previous one's state
      await runDueDunning(org.id, { asOf: new Date(start.getTime() + day * DAY_MS), limit: 50 });
    }

    const types = transport.requests.map(
      (request) => (JSON.parse(request.payload) as { type: string }).type,
    );
    expect(types).toEqual(['subscription.canceled', 'dunning.exhausted']);
  });
});

describe('cancelDunning', () => {
  it('resolves the campaign without canceling the subscription', async () => {
    const { org, invoice, subscription } = await makeBillingFixture();
    const campaign = await startDunning(org.id, invoice.id);

    const canceled = await cancelDunning(org.id, campaign.id);

    expect(canceled.status).toBe('CANCELED');
    expect(canceled.nextAttemptAt).toBeNull();
    expect(canceled.resolvedAt).not.toBeNull();

    const stillThere = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(stillThere.status).toBe('PAST_DUE');
  });

  it('rejects canceling an already resolved campaign', async () => {
    const { org, invoice } = await makeBillingFixture();
    const campaign = await startDunning(org.id, invoice.id);
    await cancelDunning(org.id, campaign.id);

    await expect(cancelDunning(org.id, campaign.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('getDunningCampaign', () => {
  it('includes the invoice, subscription, and attempt history', async () => {
    const { org, invoice } = await makeBillingFixture();
    const start = new Date('2026-06-01T00:00:00.000Z');
    const campaign = await startDunning(org.id, invoice.id, { now: start });
    await runDunningAttempt(org.id, campaign.id, { now: new Date(start.getTime() + DAY_MS) });

    const loaded = await getDunningCampaign(org.id, campaign.id);

    expect(loaded.invoice.id).toBe(invoice.id);
    expect(loaded.subscription.customer.email).toBe('jane@acme.test');
    expect(loaded.attempts).toHaveLength(1);
  });

  it('404s for another organization campaign', async () => {
    const { org, invoice } = await makeBillingFixture('Acme');
    const other = await makeOrg('Globex');
    const campaign = await startDunning(org.id, invoice.id);

    await expect(getDunningCampaign(other.id, campaign.id)).rejects.toMatchObject({ status: 404 });
  });
});
