import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createCoupon, getActiveRedemption, redeemCoupon, removeRedemption } from './coupon.service';
import { createCustomer, updateCustomer } from './customer.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import { changeSubscriptionPlan, createSubscription } from './subscription.service';
import { recordUsageEvent } from './usage.service';
import {
  finalizeInvoice,
  generateInvoice,
  getInvoice,
  listInvoices,
  markInvoicePaid,
  voidInvoice,
} from './invoice.service';

async function resetDb() {
  await prisma.couponRedemption.deleteMany();
  await prisma.coupon.deleteMany();
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
    data: { name, slug: name.toLowerCase().replace(/\s+/g, '-') },
  });
}

async function makeFlatPlan(organizationId: string, name: string, flatAmount: number) {
  const product = await createProduct(organizationId, { name: `${name} product` });
  return createPlan(organizationId, {
    productId: product.id,
    name,
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency: 'usd',
    flatAmount,
  });
}

async function makeUsagePlan(organizationId: string, name: string) {
  const product = await createProduct(organizationId, { name: `${name} product` });
  return createPlan(organizationId, {
    productId: product.id,
    name,
    pricingModel: 'USAGE',
    interval: 'MONTH',
    currency: 'usd',
    usageMetric: 'api_calls',
    usageUnitAmount: 2,
  });
}

async function makeTieredPlan(organizationId: string, name: string) {
  const product = await createProduct(organizationId, { name: `${name} product` });
  return createPlan(organizationId, {
    productId: product.id,
    name,
    pricingModel: 'TIERED',
    interval: 'MONTH',
    currency: 'usd',
    usageMetric: 'api_calls',
    tiers: [
      { upTo: 100, unitAmount: 10, flatFee: 0 },
      { upTo: null, unitAmount: 5, flatFee: 0 },
    ],
  });
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('generateInvoice', () => {
  it('generates a DRAFT invoice with a PLAN line item for a flat plan', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 2900);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.status).toBe('DRAFT');
    expect(invoice.number).toBe('INV-000001');
    expect(invoice.subtotal).toBe(2900);
    expect(invoice.taxAmount).toBe(0);
    expect(invoice.total).toBe(2900);
    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.lineItems[0]?.type).toBe('PLAN');
    expect(invoice.lineItems[0]?.amount).toBe(2900);
  });

  it('applies tax based on the customer country', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, {
      name: 'Jane Doe',
      email: 'jane@example.com',
      country: 'GB',
    });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 10000);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.subtotal).toBe(10000);
    expect(invoice.taxAmount).toBe(2000);
    expect(invoice.total).toBe(12000);
  });

  it('assigns sequential invoice numbers per organization', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const planA = await makeFlatPlan(org.id, 'Plan A', 1000);
    const planB = await makeFlatPlan(org.id, 'Plan B', 2000);
    const subA = await createSubscription(org.id, { customerId: customer.id, planId: planA.id });
    const subB = await createSubscription(org.id, { customerId: customer.id, planId: planB.id });

    const invoiceA = await generateInvoice(org.id, { subscriptionId: subA.id });
    const invoiceB = await generateInvoice(org.id, { subscriptionId: subB.id });

    expect(invoiceA.number).toBe('INV-000001');
    expect(invoiceB.number).toBe('INV-000002');
  });

  it('keeps invoice numbering independent per organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerA = await createCustomer(orgA.id, { name: 'A Customer', email: 'a@example.com' });
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    const planA = await makeFlatPlan(orgA.id, 'Plan A', 1000);
    const planB = await makeFlatPlan(orgB.id, 'Plan B', 1000);
    const subA = await createSubscription(orgA.id, { customerId: customerA.id, planId: planA.id });
    const subB = await createSubscription(orgB.id, { customerId: customerB.id, planId: planB.id });

    const invoiceA = await generateInvoice(orgA.id, { subscriptionId: subA.id });
    const invoiceB = await generateInvoice(orgB.id, { subscriptionId: subB.id });

    expect(invoiceA.number).toBe('INV-000001');
    expect(invoiceB.number).toBe('INV-000001');
  });

  it('produces no PLAN line item for a pure usage-based plan', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeUsagePlan(org.id, 'Metered API');
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.lineItems).toHaveLength(0);
    expect(invoice.subtotal).toBe(0);
    expect(invoice.total).toBe(0);
  });

  it('charges no PLAN line item for a trialing subscription', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 2900);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
      trialDays: 14,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.lineItems).toHaveLength(0);
    expect(invoice.subtotal).toBe(0);
    expect(invoice.total).toBe(0);
  });

  it('includes an uninvoiced proration as a line item', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const basicPlan = await makeFlatPlan(org.id, 'Basic', 1000);
    const proPlan = await makeFlatPlan(org.id, 'Pro', 5000);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: basicPlan.id,
    });
    const { proration } = await changeSubscriptionPlan(org.id, subscription.id, {
      planId: proPlan.id,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    const prorationLine = invoice.lineItems.find((item) => item.type === 'PRORATION');
    expect(prorationLine?.amount).toBe(proration.netAmount);
    expect(invoice.subtotal).toBe(5000 + proration.netAmount);
  });

  it('never bills the same proration event twice', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const basicPlan = await makeFlatPlan(org.id, 'Basic', 1000);
    const proPlan = await makeFlatPlan(org.id, 'Pro', 5000);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: basicPlan.id,
    });
    await changeSubscriptionPlan(org.id, subscription.id, { planId: proPlan.id });
    const first = await generateInvoice(org.id, { subscriptionId: subscription.id });
    await voidInvoice(org.id, first.id);

    const second = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(second.lineItems.some((item) => item.type === 'PRORATION')).toBe(false);
  });

  it('throws a 409 when an invoice already exists for the current period', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 2900);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    await generateInvoice(org.id, { subscriptionId: subscription.id });

    await expect(
      generateInvoice(org.id, { subscriptionId: subscription.id }),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('lets only one of two concurrent calls generate an invoice for the same period', async () => {
    // Both calls find no existing invoice before either writes, the way
    // two overlapping POST /invoices requests for the same subscription
    // would. Without the partial unique index backing this, both would
    // succeed and the period would end up with two non-VOID invoices.
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 2900);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });

    const results = await Promise.allSettled([
      generateInvoice(org.id, { subscriptionId: subscription.id }),
      generateInvoice(org.id, { subscriptionId: subscription.id }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: subscription.id } });
    expect(invoices).toHaveLength(1);
  });

  it('allows regenerating an invoice for the period once the first was voided', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 2900);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    const first = await generateInvoice(org.id, { subscriptionId: subscription.id });
    await voidInvoice(org.id, first.id);

    const second = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(second.id).not.toBe(first.id);
    expect(second.number).toBe('INV-000002');
  });

  it('throws a 400 when generating for a canceled subscription', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 2900);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELED' },
    });

    await expect(
      generateInvoice(org.id, { subscriptionId: subscription.id }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('throws a 404 when the subscription belongs to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    const planB = await makeFlatPlan(orgB.id, 'Pro Monthly', 2900);
    const subscriptionB = await createSubscription(orgB.id, {
      customerId: customerB.id,
      planId: planB.id,
    });

    await expect(
      generateInvoice(orgA.id, { subscriptionId: subscriptionB.id }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('generateInvoice usage billing', () => {
  it('includes a USAGE line item priced from aggregated usage for a USAGE plan', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeUsagePlan(org.id, 'Metered API');
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 100,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 50,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.lineItems).toHaveLength(1);
    const usageLine = invoice.lineItems[0];
    expect(usageLine?.type).toBe('USAGE');
    expect(usageLine?.quantity).toBe(150);
    expect(usageLine?.amount).toBe(150 * 2);
    expect(invoice.subtotal).toBe(300);
  });

  it('includes a USAGE line item priced from graduated tiers for a TIERED plan', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeTieredPlan(org.id, 'Tiered API');
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 150,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    // 100 units @ 10 + 50 units @ 5
    expect(invoice.subtotal).toBe(100 * 10 + 50 * 5);
    expect(invoice.lineItems[0]?.type).toBe('USAGE');
    expect(invoice.lineItems[0]?.quantity).toBe(150);
  });

  it('produces no USAGE line item when no usage was recorded', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeUsagePlan(org.id, 'Metered API');
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.lineItems).toHaveLength(0);
    expect(invoice.subtotal).toBe(0);
  });

  it('only aggregates usage matching the plan usage metric', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeUsagePlan(org.id, 'Metered API');
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 10,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'unrelated_metric',
      quantity: 1000,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.lineItems[0]?.quantity).toBe(10);
    expect(invoice.subtotal).toBe(20);
  });

  it('excludes usage recorded outside the current billing period', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeUsagePlan(org.id, 'Metered API');
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    const beforePeriod = new Date(subscription.currentPeriodStart.getTime() - 1000);
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 500,
      timestamp: beforePeriod,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 10,
      timestamp: subscription.currentPeriodEnd,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.lineItems).toHaveLength(0);
  });

  it('produces no USAGE line item for a trialing subscription even with usage recorded', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeUsagePlan(org.id, 'Metered API');
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
      trialDays: 14,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 100,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.lineItems).toHaveLength(0);
    expect(invoice.total).toBe(0);
  });

  it('prices a single-tier TIERED plan as a flat per-unit rate', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const product = await createProduct(org.id, { name: 'Single-tier product' });
    const plan = await createPlan(org.id, {
      productId: product.id,
      name: 'Per-call',
      pricingModel: 'TIERED',
      interval: 'MONTH',
      currency: 'usd',
      usageMetric: 'api_calls',
      tiers: [{ upTo: null, unitAmount: 1, flatFee: 0 }],
    });
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    await recordUsageEvent(org.id, {
      subscriptionId: subscription.id,
      metric: 'api_calls',
      quantity: 250,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.lineItems[0]?.type).toBe('USAGE');
    expect(invoice.lineItems[0]?.amount).toBe(250);
  });
});

describe('listInvoices', () => {
  it('only returns invoices for the given organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerA = await createCustomer(orgA.id, { name: 'A Customer', email: 'a@example.com' });
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    const planA = await makeFlatPlan(orgA.id, 'A Plan', 1000);
    const planB = await makeFlatPlan(orgB.id, 'B Plan', 1000);
    const subA = await createSubscription(orgA.id, { customerId: customerA.id, planId: planA.id });
    const subB = await createSubscription(orgB.id, { customerId: customerB.id, planId: planB.id });
    await generateInvoice(orgA.id, { subscriptionId: subA.id });
    await generateInvoice(orgB.id, { subscriptionId: subB.id });

    const invoices = await listInvoices(orgA.id, {});

    expect(invoices).toHaveLength(1);
  });

  it('filters by status', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const planA = await makeFlatPlan(org.id, 'Plan A', 1000);
    const planB = await makeFlatPlan(org.id, 'Plan B', 2000);
    const subA = await createSubscription(org.id, { customerId: customer.id, planId: planA.id });
    const subB = await createSubscription(org.id, { customerId: customer.id, planId: planB.id });
    const invoiceA = await generateInvoice(org.id, { subscriptionId: subA.id });
    await generateInvoice(org.id, { subscriptionId: subB.id });
    await finalizeInvoice(org.id, invoiceA.id);

    const open = await listInvoices(org.id, { status: 'OPEN' });

    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(invoiceA.id);
  });

  it('filters by customerId', async () => {
    const org = await makeOrg('Acme');
    const customerA = await createCustomer(org.id, { name: 'A Customer', email: 'a@example.com' });
    const customerB = await createCustomer(org.id, { name: 'B Customer', email: 'b@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    const subA = await createSubscription(org.id, { customerId: customerA.id, planId: plan.id });
    const subB = await createSubscription(org.id, { customerId: customerB.id, planId: plan.id });
    const invoiceA = await generateInvoice(org.id, { subscriptionId: subA.id });
    await generateInvoice(org.id, { subscriptionId: subB.id });

    const forCustomerA = await listInvoices(org.id, { customerId: customerA.id });

    expect(forCustomerA).toHaveLength(1);
    expect(forCustomerA[0]?.id).toBe(invoiceA.id);
  });

  it('filters by subscriptionId', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const planA = await makeFlatPlan(org.id, 'Plan A', 1000);
    const planB = await makeFlatPlan(org.id, 'Plan B', 2000);
    const subA = await createSubscription(org.id, { customerId: customer.id, planId: planA.id });
    const subB = await createSubscription(org.id, { customerId: customer.id, planId: planB.id });
    const invoiceB = await generateInvoice(org.id, { subscriptionId: subB.id });
    await generateInvoice(org.id, { subscriptionId: subA.id });

    const forSubB = await listInvoices(org.id, { subscriptionId: subB.id });

    expect(forSubB).toHaveLength(1);
    expect(forSubB[0]?.id).toBe(invoiceB.id);
  });
});

describe('invoice status transitions', () => {
  async function makeDraftInvoice() {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 2900);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
    });
    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });
    return { org, invoice };
  }

  it('finalizes a DRAFT invoice to OPEN', async () => {
    const { org, invoice } = await makeDraftInvoice();

    const finalized = await finalizeInvoice(org.id, invoice.id);

    expect(finalized.status).toBe('OPEN');
    expect(finalized.issuedAt).not.toBeNull();
  });

  it('marks an OPEN invoice PAID', async () => {
    const { org, invoice } = await makeDraftInvoice();
    await finalizeInvoice(org.id, invoice.id);

    const paid = await markInvoicePaid(org.id, invoice.id);

    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).not.toBeNull();
  });

  it('voids a DRAFT invoice directly', async () => {
    const { org, invoice } = await makeDraftInvoice();

    const voided = await voidInvoice(org.id, invoice.id);

    expect(voided.status).toBe('VOID');
    expect(voided.voidedAt).not.toBeNull();
  });

  it('rejects marking a DRAFT invoice PAID without finalizing first', async () => {
    const { org, invoice } = await makeDraftInvoice();

    await expect(markInvoicePaid(org.id, invoice.id)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects any transition out of PAID', async () => {
    const { org, invoice } = await makeDraftInvoice();
    await finalizeInvoice(org.id, invoice.id);
    await markInvoicePaid(org.id, invoice.id);

    await expect(voidInvoice(org.id, invoice.id)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects any transition out of VOID', async () => {
    const { org, invoice } = await makeDraftInvoice();
    await voidInvoice(org.id, invoice.id);

    await expect(finalizeInvoice(org.id, invoice.id)).rejects.toMatchObject({ status: 409 });
  });

  it('lets only one of two concurrent attempts settle the same invoice', async () => {
    // Both calls read the invoice as OPEN before either writes, the way two
    // overlapping POST /invoices/:id/charge requests for the same invoice
    // would. Without a conditional write, both would succeed and the
    // invoice would be marked PAID (and its payment.paid webhook emitted)
    // twice over.
    const { org, invoice } = await makeDraftInvoice();
    await finalizeInvoice(org.id, invoice.id);

    const results = await Promise.allSettled([
      markInvoicePaid(org.id, invoice.id),
      markInvoicePaid(org.id, invoice.id),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    const final = await getInvoice(org.id, invoice.id);
    expect(final.status).toBe('PAID');
  });
});

describe('getInvoice', () => {
  it('throws a 404 for an invoice belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    const planB = await makeFlatPlan(orgB.id, 'Pro Monthly', 2900);
    const subscriptionB = await createSubscription(orgB.id, {
      customerId: customerB.id,
      planId: planB.id,
    });
    const invoice = await generateInvoice(orgB.id, { subscriptionId: subscriptionB.id });

    await expect(getInvoice(orgA.id, invoice.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('generateInvoice with coupons', () => {
  async function makeDiscountedSubscription(
    organizationId: string,
    coupon: Parameters<typeof createCoupon>[1],
    flatAmount = 10000,
  ) {
    const customer = await createCustomer(organizationId, {
      name: 'Jane Doe',
      email: `jane-${Math.random().toString(36).slice(2)}@example.com`,
    });
    const plan = await makeFlatPlan(organizationId, 'Pro', flatAmount);
    const subscription = await createSubscription(organizationId, {
      customerId: customer.id,
      planId: plan.id,
    });
    await createCoupon(organizationId, coupon);
    const redemption = await redeemCoupon(organizationId, subscription.id, { code: coupon.code });
    return { customer, plan, subscription, redemption };
  }

  const foreverHalfOff = {
    code: 'HALFOFF',
    type: 'PERCENT_OFF' as const,
    percentOff: 50,
    duration: 'FOREVER' as const,
  };

  it('writes the discount as a line item and caches it on the invoice', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeDiscountedSubscription(org.id, foreverHalfOff);

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.subtotal).toBe(10000);
    expect(invoice.discountAmount).toBe(5000);
    expect(invoice.total).toBe(5000);
    const discountLine = invoice.lineItems.find((item) => item.type === 'DISCOUNT');
    expect(discountLine?.amount).toBe(-5000);
    expect(discountLine?.description).toContain('HALFOFF');
  });

  it('charges tax on the discounted amount, not the list price', async () => {
    const org = await makeOrg('Acme');
    const { customer, subscription } = await makeDiscountedSubscription(org.id, foreverHalfOff);
    await updateCustomer(org.id, customer.id, { country: 'GB' });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    // 20% of the discounted 5000, not of the 10000 subtotal.
    expect(invoice.taxAmount).toBe(1000);
    expect(invoice.total).toBe(6000);
  });

  it('takes a fixed amount off in the invoice currency', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeDiscountedSubscription(org.id, {
      code: 'TWENTYOFF',
      type: 'AMOUNT_OFF',
      amountOff: 2000,
      currency: 'usd',
      duration: 'FOREVER',
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.discountAmount).toBe(2000);
    expect(invoice.total).toBe(8000);
  });

  it('never discounts below zero when the coupon exceeds the subtotal', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeDiscountedSubscription(
      org.id,
      { code: 'BIGOFF', type: 'AMOUNT_OFF', amountOff: 999999, currency: 'usd', duration: 'ONCE' },
      2500,
    );

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.discountAmount).toBe(2500);
    expect(invoice.total).toBe(0);
  });

  it('counts the period against the redemption when it discounts an invoice', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeDiscountedSubscription(org.id, foreverHalfOff);

    await generateInvoice(org.id, { subscriptionId: subscription.id });

    const redemption = await getActiveRedemption(org.id, subscription.id);
    expect(redemption?.periodsApplied).toBe(1);
    expect(redemption?.status).toBe('ACTIVE');
  });

  it('stops discounting once a once-only coupon has been used', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeDiscountedSubscription(org.id, {
      code: 'FIRSTMONTH',
      type: 'PERCENT_OFF',
      percentOff: 100,
      duration: 'ONCE',
    });

    const first = await generateInvoice(org.id, { subscriptionId: subscription.id });
    expect(first.total).toBe(0);

    // Move the subscription into its next period so a second invoice is
    // allowed, the way the billing runner will.
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      },
    });

    const second = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(second.discountAmount).toBe(0);
    expect(second.total).toBe(10000);
    expect(second.lineItems.some((item) => item.type === 'DISCOUNT')).toBe(false);
  });

  it('stops discounting once a coupon is removed from the subscription', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeDiscountedSubscription(org.id, foreverHalfOff);
    await removeRedemption(org.id, subscription.id);

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.discountAmount).toBe(0);
    expect(invoice.total).toBe(10000);
  });

  it('does not spend a redemption period on an invoice with nothing to discount', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Metered', email: 'metered@example.com' });
    const plan = await makeUsagePlan(org.id, 'Metered');
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
    await createCoupon(org.id, { ...foreverHalfOff, duration: 'ONCE' });
    await redeemCoupon(org.id, subscription.id, { code: 'HALFOFF' });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.subtotal).toBe(0);
    expect(invoice.discountAmount).toBe(0);
    expect((await getActiveRedemption(org.id, subscription.id))?.periodsApplied).toBe(0);
  });

  it('leaves the invoice undiscounted when the plan currency no longer matches the coupon', async () => {
    const org = await makeOrg('Acme');
    const { plan, subscription } = await makeDiscountedSubscription(org.id, {
      code: 'USDOFF',
      type: 'AMOUNT_OFF',
      amountOff: 1000,
      currency: 'usd',
      duration: 'FOREVER',
    });
    // Repricing the plan in another currency after the coupon was redeemed.
    await prisma.plan.update({ where: { id: plan.id }, data: { currency: 'eur' } });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.discountAmount).toBe(0);
    expect(invoice.total).toBe(10000);
  });
});

describe('generateInvoice tax treatment', () => {
  async function makeSubscriptionForCustomer(
    organizationId: string,
    customerInput: Parameters<typeof createCustomer>[1],
  ) {
    const customer = await createCustomer(organizationId, customerInput);
    const plan = await makeFlatPlan(organizationId, 'Pro', 10000);
    const subscription = await createSubscription(organizationId, {
      customerId: customer.id,
      planId: plan.id,
    });
    return { customer, subscription };
  }

  it('taxes an ordinary customer at their country rate', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeSubscriptionForCustomer(org.id, {
      name: 'Consumer',
      email: 'consumer@example.de',
      country: 'DE',
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.taxAmount).toBe(1900);
    expect(invoice.total).toBe(11900);
  });

  it('charges no tax to a customer with an exemption on file', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeSubscriptionForCustomer(org.id, {
      name: 'Charity',
      email: 'charity@example.de',
      country: 'DE',
      taxExempt: true,
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.taxAmount).toBe(0);
    expect(invoice.total).toBe(10000);
  });

  it('reverse-charges an EU business that supplied a VAT id', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeSubscriptionForCustomer(org.id, {
      name: 'GmbH',
      email: 'ap@example.de',
      country: 'DE',
      taxId: 'DE123456789',
    });

    const invoice = await generateInvoice(org.id, { subscriptionId: subscription.id });

    expect(invoice.taxAmount).toBe(0);
    expect(invoice.total).toBe(10000);
  });
});
