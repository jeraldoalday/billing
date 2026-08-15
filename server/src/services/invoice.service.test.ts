import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createCustomer } from './customer.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import { changeSubscriptionPlan, createSubscription } from './subscription.service';
import {
  finalizeInvoice,
  generateInvoice,
  getInvoice,
  listInvoices,
  markInvoicePaid,
  voidInvoice,
} from './invoice.service';

async function resetDb() {
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
