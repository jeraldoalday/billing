import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createCoupon, redeemCoupon } from './coupon.service';
import { createCustomer } from './customer.service';
import { finalizeInvoice, generateInvoice, markInvoicePaid } from './invoice.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import { cancelSubscription, createSubscription } from './subscription.service';
import {
  getChurnReport,
  getMrrReport,
  getRevenueReport,
  getSummaryReport,
} from './reporting.service';

async function resetDb() {
  await prisma.couponRedemption.deleteMany();
  await prisma.coupon.deleteMany();
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
    data: { name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}` },
  });
}

async function makeCustomer(organizationId: string, name = 'Jane Doe') {
  return createCustomer(organizationId, {
    name,
    email: `${Math.random().toString(36).slice(2)}@example.com`,
  });
}

async function makeFlatPlan(
  organizationId: string,
  name: string,
  flatAmount: number,
  interval: 'MONTH' | 'YEAR' = 'MONTH',
  currency = 'usd',
) {
  const product = await createProduct(organizationId, { name: `${name} product` });
  return createPlan(organizationId, {
    productId: product.id,
    name,
    pricingModel: 'FLAT',
    interval,
    currency,
    flatAmount,
  });
}

// Subscriptions are created through the service (so their events and
// defaults are real) and then backdated, since createdAt/canceledAt are
// what every cohort figure is measured against.
async function backdate(subscriptionId: string, createdAt: Date, canceledAt: Date | null = null) {
  return prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      createdAt,
      canceledAt,
      status: canceledAt ? 'CANCELED' : undefined,
    },
  });
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('getMrrReport', () => {
  it('reports zero for an organization with no subscriptions', async () => {
    const org = await makeOrg('Acme');

    const report = await getMrrReport(org.id, { groupBy: 'plan' });

    expect(report).toMatchObject({ mrr: 0, subscriptions: 0, customers: 0, arpu: 0, breakdown: [] });
  });

  it('sums flat plans, normalizing yearly prices onto a monthly basis', async () => {
    const org = await makeOrg('Acme');
    const monthly = await makeFlatPlan(org.id, 'Pro', 5000);
    const yearly = await makeFlatPlan(org.id, 'Pro Annual', 120000, 'YEAR');
    await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: monthly.id,
    });
    await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: yearly.id,
    });

    const report = await getMrrReport(org.id, { groupBy: 'plan' });

    expect(report.mrr).toBe(15000);
    expect(report.subscriptions).toBe(2);
  });

  it('leaves trialing and canceled subscriptions out of MRR', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const trialing = await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: plan.id,
      trialDays: 14,
    });
    const canceled = await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: plan.id,
    });
    await cancelSubscription(org.id, canceled.id, { atPeriodEnd: false });

    const report = await getMrrReport(org.id, { groupBy: 'plan' });

    expect(report.mrr).toBe(0);
    expect(report.subscriptions).toBe(0);
    expect(trialing.status).toBe('TRIALING');
  });

  it('still counts a past-due subscription being recovered by dunning', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const subscription = await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: plan.id,
    });
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: 'PAST_DUE' } });

    expect((await getMrrReport(org.id, { groupBy: 'plan' })).mrr).toBe(5000);
  });

  it('nets an active coupon out of MRR', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const subscription = await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: plan.id,
    });
    await createCoupon(org.id, {
      code: 'HALFOFF',
      type: 'PERCENT_OFF',
      percentOff: 50,
      duration: 'FOREVER',
    });
    await redeemCoupon(org.id, subscription.id, { code: 'HALFOFF' });

    expect((await getMrrReport(org.id, { groupBy: 'plan' })).mrr).toBe(2500);
  });

  it('ignores a coupon whose duration is already spent', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const subscription = await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: plan.id,
    });
    await createCoupon(org.id, {
      code: 'FIRSTMONTH',
      type: 'PERCENT_OFF',
      percentOff: 100,
      duration: 'ONCE',
    });
    const redemption = await redeemCoupon(org.id, subscription.id, { code: 'FIRSTMONTH' });
    await prisma.couponRedemption.update({
      where: { id: redemption.id },
      data: { periodsApplied: 1 },
    });

    expect((await getMrrReport(org.id, { groupBy: 'plan' })).mrr).toBe(5000);
  });

  it('counts a customer with two subscriptions once for ARPU', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const customer = await makeCustomer(org.id);
    await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
    await createSubscription(org.id, { customerId: customer.id, planId: plan.id });

    const report = await getMrrReport(org.id, { groupBy: 'plan' });

    expect(report.subscriptions).toBe(2);
    expect(report.customers).toBe(1);
    expect(report.arpu).toBe(10000);
  });

  it('groups the breakdown by plan, interval, or currency', async () => {
    const org = await makeOrg('Acme');
    const monthly = await makeFlatPlan(org.id, 'Pro', 5000);
    const yearly = await makeFlatPlan(org.id, 'Pro Annual', 120000, 'YEAR', 'eur');
    await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: monthly.id,
    });
    await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: yearly.id,
    });

    const byPlan = await getMrrReport(org.id, { groupBy: 'plan' });
    expect(byPlan.breakdown.map((entry) => entry.label).sort()).toEqual(['Pro', 'Pro Annual']);

    const byInterval = await getMrrReport(org.id, { groupBy: 'interval' });
    expect(byInterval.breakdown.map((entry) => entry.label).sort()).toEqual(['MONTH', 'YEAR']);

    const byCurrency = await getMrrReport(org.id, { groupBy: 'currency' });
    expect(byCurrency.breakdown.map((entry) => entry.label).sort()).toEqual(['EUR', 'USD']);
  });

  it('never counts another organization revenue', async () => {
    const orgA = await makeOrg('Acme');
    const orgB = await makeOrg('Globex');
    const plan = await makeFlatPlan(orgB.id, 'Pro', 5000);
    await createSubscription(orgB.id, {
      customerId: (await makeCustomer(orgB.id)).id,
      planId: plan.id,
    });

    expect((await getMrrReport(orgA.id, { groupBy: 'plan' })).mrr).toBe(0);
  });
});

describe('getChurnReport', () => {
  const from = new Date('2026-02-01T00:00:00Z');
  const to = new Date('2026-03-01T00:00:00Z');

  async function makeSubscriptionFor(organizationId: string, planId: string, customerId?: string) {
    const customer = customerId ?? (await makeCustomer(organizationId)).id;
    const subscription = await createSubscription(organizationId, { customerId: customer, planId });
    return { subscription, customerId: customer };
  }

  it('reports no churn when nothing was live', async () => {
    const org = await makeOrg('Acme');

    const report = await getChurnReport(org.id, { from, to });

    expect(report.subscriptions).toMatchObject({ atStart: 0, churned: 0, churnRate: 0 });
    expect(report.customers.churnRate).toBe(0);
  });

  it('measures churn against the cohort that was live when the window opened', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const kept = await makeSubscriptionFor(org.id, plan.id);
    const lost = await makeSubscriptionFor(org.id, plan.id);
    await backdate(kept.subscription.id, new Date('2026-01-01T00:00:00Z'));
    await backdate(lost.subscription.id, new Date('2026-01-01T00:00:00Z'), new Date('2026-02-15T00:00:00Z'));

    const report = await getChurnReport(org.id, { from, to });

    expect(report.subscriptions.atStart).toBe(2);
    expect(report.subscriptions.churned).toBe(1);
    expect(report.subscriptions.churnRate).toBe(50);
    expect(report.subscriptions.retentionRate).toBe(50);
  });

  it('excludes a subscription that both started and ended inside the window', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const shortLived = await makeSubscriptionFor(org.id, plan.id);
    await backdate(
      shortLived.subscription.id,
      new Date('2026-02-05T00:00:00Z'),
      new Date('2026-02-20T00:00:00Z'),
    );

    const report = await getChurnReport(org.id, { from, to });

    expect(report.subscriptions.atStart).toBe(0);
    expect(report.subscriptions.churned).toBe(0);
  });

  it('does not count a plan switch as customer churn', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const customer = await makeCustomer(org.id);
    const dropped = await makeSubscriptionFor(org.id, plan.id, customer.id);
    const replacement = await makeSubscriptionFor(org.id, plan.id, customer.id);
    await backdate(dropped.subscription.id, new Date('2026-01-01T00:00:00Z'), new Date('2026-02-10T00:00:00Z'));
    await backdate(replacement.subscription.id, new Date('2026-02-10T00:00:00Z'));

    const report = await getChurnReport(org.id, { from, to });

    expect(report.subscriptions.churned).toBe(1);
    expect(report.customers.atStart).toBe(1);
    expect(report.customers.churned).toBe(0);
  });

  it('counts a customer who lost their last subscription as churned', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const leaving = await makeSubscriptionFor(org.id, plan.id);
    await backdate(leaving.subscription.id, new Date('2026-01-01T00:00:00Z'), new Date('2026-02-10T00:00:00Z'));

    const report = await getChurnReport(org.id, { from, to });

    expect(report.customers.atStart).toBe(1);
    expect(report.customers.churned).toBe(1);
    expect(report.customers.churnRate).toBe(100);
  });

  it('ignores a cancellation that happened after the window closed', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    const later = await makeSubscriptionFor(org.id, plan.id);
    await backdate(later.subscription.id, new Date('2026-01-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'));

    const report = await getChurnReport(org.id, { from, to });

    expect(report.subscriptions.atStart).toBe(1);
    expect(report.subscriptions.churned).toBe(0);
  });
});

describe('getRevenueReport', () => {
  const from = new Date('2026-02-01T00:00:00Z');
  const to = new Date('2026-03-01T00:00:00Z');

  async function makePaidInvoice(
    organizationId: string,
    flatAmount: number,
    paidAt: Date,
    country?: string,
  ) {
    const customer = await createCustomer(organizationId, {
      name: 'Jane Doe',
      email: `${Math.random().toString(36).slice(2)}@example.com`,
      country,
    });
    const plan = await makeFlatPlan(organizationId, `Plan ${flatAmount}`, flatAmount);
    const subscription = await createSubscription(organizationId, {
      customerId: customer.id,
      planId: plan.id,
    });
    const draft = await generateInvoice(organizationId, { subscriptionId: subscription.id });
    await finalizeInvoice(organizationId, draft.id);
    const paid = await markInvoicePaid(organizationId, draft.id);
    return prisma.invoice.update({ where: { id: paid.id }, data: { paidAt } });
  }

  it('sums invoices paid inside the window only', async () => {
    const org = await makeOrg('Acme');
    await makePaidInvoice(org.id, 5000, new Date('2026-02-10T00:00:00Z'));
    await makePaidInvoice(org.id, 3000, new Date('2026-01-10T00:00:00Z'));

    const report = await getRevenueReport(org.id, { from, to });

    expect(report.invoices).toBe(1);
    expect(report.grossRevenue).toBe(5000);
  });

  it('reports revenue net of the tax owed onward', async () => {
    const org = await makeOrg('Acme');
    await makePaidInvoice(org.id, 10000, new Date('2026-02-10T00:00:00Z'), 'GB');

    const report = await getRevenueReport(org.id, { from, to });

    expect(report.grossRevenue).toBe(12000);
    expect(report.tax).toBe(2000);
    expect(report.netRevenue).toBe(10000);
  });

  it('reports what coupons cost over the window', async () => {
    const org = await makeOrg('Acme');
    const customer = await makeCustomer(org.id);
    const plan = await makeFlatPlan(org.id, 'Pro', 10000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
    await createCoupon(org.id, {
      code: 'HALFOFF',
      type: 'PERCENT_OFF',
      percentOff: 50,
      duration: 'FOREVER',
    });
    await redeemCoupon(org.id, subscription.id, { code: 'HALFOFF' });
    const draft = await generateInvoice(org.id, { subscriptionId: subscription.id });
    await finalizeInvoice(org.id, draft.id);
    const paid = await markInvoicePaid(org.id, draft.id);
    await prisma.invoice.update({
      where: { id: paid.id },
      data: { paidAt: new Date('2026-02-10T00:00:00Z') },
    });

    const report = await getRevenueReport(org.id, { from, to });

    expect(report.discounts).toBe(5000);
    expect(report.grossRevenue).toBe(5000);
  });

  it('reports issued-but-unpaid invoices as outstanding', async () => {
    const org = await makeOrg('Acme');
    const customer = await makeCustomer(org.id);
    const plan = await makeFlatPlan(org.id, 'Pro', 7500);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
    const draft = await generateInvoice(org.id, { subscriptionId: subscription.id });
    const open = await finalizeInvoice(org.id, draft.id);
    await prisma.invoice.update({
      where: { id: open.id },
      data: { issuedAt: new Date('2026-02-05T00:00:00Z') },
    });

    const report = await getRevenueReport(org.id, { from, to });

    expect(report.grossRevenue).toBe(0);
    expect(report.outstanding).toBe(7500);
  });

  it('never counts another organization revenue', async () => {
    const orgA = await makeOrg('Acme');
    const orgB = await makeOrg('Globex');
    await makePaidInvoice(orgB.id, 5000, new Date('2026-02-10T00:00:00Z'));

    expect((await getRevenueReport(orgA.id, { from, to })).grossRevenue).toBe(0);
  });
});

describe('getSummaryReport', () => {
  it('answers all three reports from one call', async () => {
    const org = await makeOrg('Acme');
    const plan = await makeFlatPlan(org.id, 'Pro', 5000);
    await createSubscription(org.id, {
      customerId: (await makeCustomer(org.id)).id,
      planId: plan.id,
    });

    const report = await getSummaryReport(org.id, {
      from: new Date('2026-02-01T00:00:00Z'),
      to: new Date('2026-03-01T00:00:00Z'),
    });

    expect(report.mrr.mrr).toBe(5000);
    expect(report.churn.subscriptions.churnRate).toBe(0);
    expect(report.revenue.grossRevenue).toBe(0);
  });
});
