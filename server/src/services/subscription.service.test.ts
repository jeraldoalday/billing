import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createCustomer } from './customer.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import {
  cancelSubscription,
  changeSubscriptionPlan,
  createSubscription,
  endTrial,
  getSubscription,
  listSubscriptions,
} from './subscription.service';

async function resetDb() {
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.product.deleteMany();
  await prisma.organization.deleteMany();
}

async function makeOrg(name: string) {
  return prisma.organization.create({ data: { name, slug: name.toLowerCase().replace(/\s+/g, '-') } });
}

async function makeFlatPlan(organizationId: string, name: string, flatAmount: number, active = true) {
  const product = await createProduct(organizationId, { name: `${name} product` });
  return createPlan(organizationId, {
    productId: product.id,
    name,
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency: 'usd',
    flatAmount,
    active,
  });
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('createSubscription', () => {
  it('creates an ACTIVE subscription with no trial', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 2900);

    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });

    expect(subscription.status).toBe('ACTIVE');
    expect(subscription.trialEnd).toBeNull();
    expect(subscription.currentPeriodEnd.getTime()).toBeGreaterThan(subscription.currentPeriodStart.getTime());

    const events = await prisma.subscriptionEvent.findMany({ where: { subscriptionId: subscription.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('CREATED');
  });

  it('creates a TRIALING subscription when trialDays is given', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 2900);

    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id, trialDays: 14 });

    expect(subscription.status).toBe('TRIALING');
    expect(subscription.trialEnd).not.toBeNull();
    expect(subscription.currentPeriodEnd).toEqual(subscription.trialEnd);

    const events = await prisma.subscriptionEvent.findMany({ where: { subscriptionId: subscription.id } });
    expect(events[0]?.type).toBe('TRIAL_STARTED');
  });

  it('throws a 400 when the plan is inactive', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Retired Plan', 2900, false);

    await expect(createSubscription(org.id, { customerId: customer.id, planId: plan.id })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('throws a 404 when the customer belongs to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    const planA = await makeFlatPlan(orgA.id, 'Pro Monthly', 2900);

    await expect(
      createSubscription(orgA.id, { customerId: customerB.id, planId: planA.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('throws a 404 when the plan belongs to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerA = await createCustomer(orgA.id, { name: 'A Customer', email: 'a@example.com' });
    const planB = await makeFlatPlan(orgB.id, 'Pro Monthly', 2900);

    await expect(
      createSubscription(orgA.id, { customerId: customerA.id, planId: planB.id }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('listSubscriptions', () => {
  it('only returns subscriptions for the given organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerA = await createCustomer(orgA.id, { name: 'A Customer', email: 'a@example.com' });
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    const planA = await makeFlatPlan(orgA.id, 'A Plan', 1000);
    const planB = await makeFlatPlan(orgB.id, 'B Plan', 1000);
    await createSubscription(orgA.id, { customerId: customerA.id, planId: planA.id });
    await createSubscription(orgB.id, { customerId: customerB.id, planId: planB.id });

    const subscriptions = await listSubscriptions(orgA.id, {});

    expect(subscriptions).toHaveLength(1);
  });

  it('filters by status', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
    await createSubscription(org.id, { customerId: customer.id, planId: plan.id, trialDays: 14 });

    const trialing = await listSubscriptions(org.id, { status: 'TRIALING' });

    expect(trialing).toHaveLength(1);
    expect(trialing[0]?.status).toBe('TRIALING');
  });
});

describe('cancelSubscription', () => {
  it('cancels immediately by default', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });

    const canceled = await cancelSubscription(org.id, subscription.id, { atPeriodEnd: false });

    expect(canceled.status).toBe('CANCELED');
    expect(canceled.canceledAt).not.toBeNull();
  });

  it('schedules cancellation at period end without changing status yet', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });

    const result = await cancelSubscription(org.id, subscription.id, { atPeriodEnd: true });

    expect(result.status).toBe('ACTIVE');
    expect(result.canceledAt).toBeNull();
    expect(result.cancelAt).toEqual(subscription.currentPeriodEnd);
  });

  it('throws a 409 when canceling an already-canceled subscription', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
    await cancelSubscription(org.id, subscription.id, { atPeriodEnd: false });

    await expect(cancelSubscription(org.id, subscription.id, { atPeriodEnd: false })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('lets only one of two concurrent cancellations apply', async () => {
    // Both calls read a not-yet-canceled subscription before either writes,
    // the way two overlapping DELETE /subscriptions/:id requests would.
    // Without a conditional write, both would succeed, each creating a
    // CANCELED SubscriptionEvent and emitting subscription.canceled.
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });

    const results = await Promise.allSettled([
      cancelSubscription(org.id, subscription.id, { atPeriodEnd: false }),
      cancelSubscription(org.id, subscription.id, { atPeriodEnd: false }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    const events = await prisma.subscriptionEvent.findMany({
      where: { subscriptionId: subscription.id, type: 'CANCELED' },
    });
    expect(events).toHaveLength(1);
  });
});

describe('changeSubscriptionPlan', () => {
  it('switches plans and returns a proration with a positive net on an upgrade', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const basicPlan = await makeFlatPlan(org.id, 'Basic', 1000);
    const proPlan = await makeFlatPlan(org.id, 'Pro', 5000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: basicPlan.id });

    const result = await changeSubscriptionPlan(org.id, subscription.id, { planId: proPlan.id });

    expect(result.subscription.planId).toBe(proPlan.id);
    expect(result.proration.netAmount).toBeGreaterThanOrEqual(0);
    expect(result.proration.chargeAmount).toBeGreaterThanOrEqual(result.proration.creditAmount);

    const events = await prisma.subscriptionEvent.findMany({ where: { subscriptionId: subscription.id } });
    const planChanged = events.find((e) => e.type === 'PLAN_CHANGED');
    expect(planChanged?.previousPlanId).toBe(basicPlan.id);
    expect(planChanged?.newPlanId).toBe(proPlan.id);
    expect(planChanged?.prorationAmount).toBe(result.proration.netAmount);
  });

  it('returns a negative net proration on a downgrade', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const proPlan = await makeFlatPlan(org.id, 'Pro', 5000);
    const basicPlan = await makeFlatPlan(org.id, 'Basic', 1000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: proPlan.id });

    const result = await changeSubscriptionPlan(org.id, subscription.id, { planId: basicPlan.id });

    expect(result.proration.netAmount).toBeLessThanOrEqual(0);
  });

  it('throws a 400 when switching to the current plan', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });

    await expect(changeSubscriptionPlan(org.id, subscription.id, { planId: plan.id })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('throws a 409 when changing the plan of a canceled subscription', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const planA = await makeFlatPlan(org.id, 'Plan A', 1000);
    const planB = await makeFlatPlan(org.id, 'Plan B', 2000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: planA.id });
    await cancelSubscription(org.id, subscription.id, { atPeriodEnd: false });

    await expect(changeSubscriptionPlan(org.id, subscription.id, { planId: planB.id })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('endTrial', () => {
  it('transitions a TRIALING subscription to ACTIVE with a fresh period', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
      trialDays: 14,
    });

    const activated = await endTrial(org.id, subscription.id);

    expect(activated.status).toBe('ACTIVE');
    expect(activated.currentPeriodEnd.getTime()).toBeGreaterThan(subscription.trialEnd!.getTime());
  });

  it('throws a 400 when ending the trial of a non-trialing subscription', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });

    await expect(endTrial(org.id, subscription.id)).rejects.toMatchObject({ status: 400 });
  });

  it('lets only one of two concurrent calls end the same trial', async () => {
    // Same race as cancelSubscription: both calls read TRIALING before
    // either writes, the way two overlapping requests would. Without a
    // conditional write, both would succeed, each creating a TRIAL_ENDED
    // event and emitting subscription.updated.
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const plan = await makeFlatPlan(org.id, 'Pro Monthly', 1000);
    const subscription = await createSubscription(org.id, {
      customerId: customer.id,
      planId: plan.id,
      trialDays: 14,
    });

    const results = await Promise.allSettled([
      endTrial(org.id, subscription.id),
      endTrial(org.id, subscription.id),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 400 });

    const events = await prisma.subscriptionEvent.findMany({
      where: { subscriptionId: subscription.id, type: 'TRIAL_ENDED' },
    });
    expect(events).toHaveLength(1);
  });
});

describe('getSubscription', () => {
  it('throws a 404 for a subscription belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    const planB = await makeFlatPlan(orgB.id, 'Pro Monthly', 1000);
    const subscription = await createSubscription(orgB.id, { customerId: customerB.id, planId: planB.id });

    await expect(getSubscription(orgA.id, subscription.id)).rejects.toMatchObject({ status: 404 });
  });
});
