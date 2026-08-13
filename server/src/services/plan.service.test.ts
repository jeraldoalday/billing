import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createCustomer } from './customer.service';
import { createProduct } from './product.service';
import { createSubscription } from './subscription.service';
import { createPlan, deletePlan, getPlan, listPlans, updatePlan } from './plan.service';

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

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('createPlan', () => {
  it('creates a flat plan', async () => {
    const org = await makeOrg('Acme');
    const product = await createProduct(org.id, { name: 'API Access' });

    const plan = await createPlan(org.id, {
      productId: product.id,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 2900,
    });

    expect(plan.flatAmount).toBe(2900);
    expect(plan.usageMetric).toBeNull();
    expect(plan.tiers).toHaveLength(0);
  });

  it('creates a usage plan', async () => {
    const org = await makeOrg('Acme');
    const product = await createProduct(org.id, { name: 'API Access' });

    const plan = await createPlan(org.id, {
      productId: product.id,
      name: 'Metered API Calls',
      pricingModel: 'USAGE',
      interval: 'MONTH',
      currency: 'usd',
      usageMetric: 'api_calls',
      usageUnitAmount: 2,
    });

    expect(plan.usageMetric).toBe('api_calls');
    expect(plan.usageUnitAmount).toBe(2);
    expect(plan.flatAmount).toBeNull();
  });

  it('creates a tiered plan with ordered tiers', async () => {
    const org = await makeOrg('Acme');
    const product = await createProduct(org.id, { name: 'Storage' });

    const plan = await createPlan(org.id, {
      productId: product.id,
      name: 'Storage Tiers',
      pricingModel: 'TIERED',
      interval: 'MONTH',
      currency: 'usd',
      usageMetric: 'gb_stored',
      tiers: [
        { upTo: 100, unitAmount: 10, flatFee: 0 },
        { upTo: 500, unitAmount: 8, flatFee: 0 },
        { upTo: null, unitAmount: 5, flatFee: 0 },
      ],
    });

    expect(plan.tiers).toHaveLength(3);
    expect(plan.tiers.map((t) => t.order)).toEqual([0, 1, 2]);
    expect(plan.tiers[2]?.upTo).toBeNull();
  });

  it('throws a 404 when the product belongs to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const productB = await createProduct(orgB.id, { name: 'B Product' });

    await expect(
      createPlan(orgA.id, {
        productId: productB.id,
        name: 'Hijacked Plan',
        pricingModel: 'FLAT',
        interval: 'MONTH',
        currency: 'usd',
        flatAmount: 100,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('listPlans', () => {
  it('only returns plans for the given organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const productA = await createProduct(orgA.id, { name: 'A Product' });
    const productB = await createProduct(orgB.id, { name: 'B Product' });
    await createPlan(orgA.id, {
      productId: productA.id,
      name: 'A Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 100,
    });
    await createPlan(orgB.id, {
      productId: productB.id,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 100,
    });

    const plans = await listPlans(orgA.id, {});

    expect(plans).toHaveLength(1);
    expect(plans[0]?.name).toBe('A Plan');
  });

  it('filters by productId', async () => {
    const org = await makeOrg('Acme');
    const productA = await createProduct(org.id, { name: 'Product A' });
    const productB = await createProduct(org.id, { name: 'Product B' });
    await createPlan(org.id, {
      productId: productA.id,
      name: 'A Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 100,
    });
    await createPlan(org.id, {
      productId: productB.id,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 100,
    });

    const plans = await listPlans(org.id, { productId: productA.id });

    expect(plans.map((p) => p.name)).toEqual(['A Plan']);
  });
});

describe('getPlan', () => {
  it('returns the plan with its tiers when owned by the organization', async () => {
    const org = await makeOrg('Acme');
    const product = await createProduct(org.id, { name: 'Storage' });
    const created = await createPlan(org.id, {
      productId: product.id,
      name: 'Storage Tiers',
      pricingModel: 'TIERED',
      interval: 'MONTH',
      currency: 'usd',
      usageMetric: 'gb_stored',
      tiers: [{ upTo: null, unitAmount: 5, flatFee: 0 }],
    });

    const found = await getPlan(org.id, created.id);

    expect(found.tiers).toHaveLength(1);
  });

  it('throws a 404 for a plan belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const productB = await createProduct(orgB.id, { name: 'B Product' });
    const plan = await createPlan(orgB.id, {
      productId: productB.id,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 100,
    });

    await expect(getPlan(orgA.id, plan.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('updatePlan', () => {
  it('updates name and active but leaves pricing untouched', async () => {
    const org = await makeOrg('Acme');
    const product = await createProduct(org.id, { name: 'API Access' });
    const created = await createPlan(org.id, {
      productId: product.id,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 2900,
    });

    const updated = await updatePlan(org.id, created.id, { name: 'Pro Monthly (legacy)', active: false });

    expect(updated.name).toBe('Pro Monthly (legacy)');
    expect(updated.active).toBe(false);
    expect(updated.flatAmount).toBe(2900);
  });

  it('refuses to update a plan belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const productB = await createProduct(orgB.id, { name: 'B Product' });
    const plan = await createPlan(orgB.id, {
      productId: productB.id,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 100,
    });

    await expect(updatePlan(orgA.id, plan.id, { name: 'Hijacked' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('deletePlan', () => {
  it('deletes a plan owned by the organization, cascading to its tiers', async () => {
    const org = await makeOrg('Acme');
    const product = await createProduct(org.id, { name: 'Storage' });
    const created = await createPlan(org.id, {
      productId: product.id,
      name: 'Storage Tiers',
      pricingModel: 'TIERED',
      interval: 'MONTH',
      currency: 'usd',
      usageMetric: 'gb_stored',
      tiers: [{ upTo: null, unitAmount: 5, flatFee: 0 }],
    });

    await deletePlan(org.id, created.id);

    await expect(getPlan(org.id, created.id)).rejects.toMatchObject({ status: 404 });
    expect(await prisma.priceTier.count({ where: { planId: created.id } })).toBe(0);
  });

  it('refuses to delete a plan belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const productB = await createProduct(orgB.id, { name: 'B Product' });
    const plan = await createPlan(orgB.id, {
      productId: productB.id,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 100,
    });

    await expect(deletePlan(orgA.id, plan.id)).rejects.toMatchObject({ status: 404 });
    await expect(getPlan(orgB.id, plan.id)).resolves.toMatchObject({ id: plan.id });
  });

  it('refuses to delete a plan that a subscription references', async () => {
    const org = await makeOrg('Acme');
    const product = await createProduct(org.id, { name: 'API Access' });
    const plan = await createPlan(org.id, {
      productId: product.id,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 2900,
    });
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    await createSubscription(org.id, { customerId: customer.id, planId: plan.id });

    await expect(deletePlan(org.id, plan.id)).rejects.toMatchObject({ status: 409 });
    await expect(getPlan(org.id, plan.id)).resolves.toMatchObject({ id: plan.id });
  });
});
