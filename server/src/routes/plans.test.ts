import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

async function resetDb() {
  await prisma.plan.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

async function signupAndGetToken(email = 'user@acme.test') {
  const res = await request(app)
    .post('/auth/signup')
    .send({ organizationName: 'Acme Corp', email, password: 'super-secret-1' });
  return res.body.token as string;
}

async function createProductAs(token: string, name = 'API Access') {
  const res = await request(app).post('/products').set('Authorization', `Bearer ${token}`).send({ name });
  return res.body.product.id as string;
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('POST /plans', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).post('/plans').send({});

    expect(res.status).toBe(401);
  });

  it('creates a flat plan', async () => {
    const token = await signupAndGetToken();
    const productId = await createProductAs(token);

    const res = await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
      productId,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 2900,
    });

    expect(res.status).toBe(201);
    expect(res.body.plan.pricingModel).toBe('FLAT');
    expect(res.body.plan.flatAmount).toBe(2900);
    expect(res.body.plan.currency).toBe('usd');
  });

  it('creates a tiered plan with nested tiers', async () => {
    const token = await signupAndGetToken();
    const productId = await createProductAs(token, 'Storage');

    const res = await request(app)
      .post('/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({
        productId,
        name: 'Storage Tiers',
        pricingModel: 'TIERED',
        interval: 'MONTH',
        usageMetric: 'gb_stored',
        tiers: [
          { upTo: 100, unitAmount: 10 },
          { upTo: null, unitAmount: 5 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.plan.tiers).toHaveLength(2);
    expect(res.body.plan.tiers[0].upTo).toBe(100);
    expect(res.body.plan.tiers[1].upTo).toBeNull();
  });

  it('rejects a tiered plan with out-of-order tiers with 400', async () => {
    const token = await signupAndGetToken();
    const productId = await createProductAs(token, 'Storage');

    const res = await request(app)
      .post('/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({
        productId,
        name: 'Storage Tiers',
        pricingModel: 'TIERED',
        interval: 'MONTH',
        usageMetric: 'gb_stored',
        tiers: [
          { upTo: 100, unitAmount: 10 },
          { upTo: 50, unitAmount: 5 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a flat plan missing flatAmount with 400', async () => {
    const token = await signupAndGetToken();
    const productId = await createProductAs(token);

    const res = await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
      productId,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
    });

    expect(res.status).toBe(400);
  });

  it('returns 404 when the product belongs to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const productIdB = await createProductAs(tokenB, 'B Product');

    const res = await request(app).post('/plans').set('Authorization', `Bearer ${tokenA}`).send({
      productId: productIdB,
      name: 'Hijacked Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 100,
    });

    expect(res.status).toBe(404);
  });
});

describe('GET /plans', () => {
  it('only lists plans belonging to the caller organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const productIdA = await createProductAs(tokenA, 'A Product');
    const productIdB = await createProductAs(tokenB, 'B Product');
    await request(app).post('/plans').set('Authorization', `Bearer ${tokenA}`).send({
      productId: productIdA,
      name: 'A Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 100,
    });
    await request(app).post('/plans').set('Authorization', `Bearer ${tokenB}`).send({
      productId: productIdB,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 100,
    });

    const res = await request(app).get('/plans').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0].name).toBe('A Plan');
  });

  it('filters by productId', async () => {
    const token = await signupAndGetToken();
    const productIdA = await createProductAs(token, 'Product A');
    const productIdB = await createProductAs(token, 'Product B');
    await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
      productId: productIdA,
      name: 'A Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 100,
    });
    await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
      productId: productIdB,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 100,
    });

    const res = await request(app).get(`/plans?productId=${productIdA}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.plans.map((p: { name: string }) => p.name)).toEqual(['A Plan']);
  });
});

describe('GET /plans/:id', () => {
  it('returns 404 for a plan belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const productIdB = await createProductAs(tokenB, 'B Product');
    const created = await request(app).post('/plans').set('Authorization', `Bearer ${tokenB}`).send({
      productId: productIdB,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 100,
    });

    const res = await request(app)
      .get(`/plans/${created.body.plan.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});

describe('PATCH /plans/:id', () => {
  it('updates name and active for a plan owned by the caller', async () => {
    const token = await signupAndGetToken();
    const productId = await createProductAs(token);
    const created = await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
      productId,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 2900,
    });

    const res = await request(app)
      .patch(`/plans/${created.body.plan.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pro Monthly (legacy)', active: false });

    expect(res.status).toBe(200);
    expect(res.body.plan.name).toBe('Pro Monthly (legacy)');
    expect(res.body.plan.active).toBe(false);
    expect(res.body.plan.flatAmount).toBe(2900);
  });

  it('ignores attempts to change pricing fields via update', async () => {
    const token = await signupAndGetToken();
    const productId = await createProductAs(token);
    const created = await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
      productId,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 2900,
    });

    const res = await request(app)
      .patch(`/plans/${created.body.plan.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Still Pro Monthly', flatAmount: 1 });

    expect(res.status).toBe(200);
    expect(res.body.plan.flatAmount).toBe(2900);
  });

  it('returns 404 when patching a plan belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const productIdB = await createProductAs(tokenB, 'B Product');
    const created = await request(app).post('/plans').set('Authorization', `Bearer ${tokenB}`).send({
      productId: productIdB,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 100,
    });

    const res = await request(app)
      .patch(`/plans/${created.body.plan.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /plans/:id', () => {
  it('deletes a plan owned by the caller', async () => {
    const token = await signupAndGetToken();
    const productId = await createProductAs(token);
    const created = await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
      productId,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 2900,
    });

    const res = await request(app)
      .delete(`/plans/${created.body.plan.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    const getRes = await request(app)
      .get(`/plans/${created.body.plan.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(404);
  });

  it('returns 404 when deleting a plan belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const productIdB = await createProductAs(tokenB, 'B Product');
    const created = await request(app).post('/plans').set('Authorization', `Bearer ${tokenB}`).send({
      productId: productIdB,
      name: 'B Plan',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 100,
    });

    const res = await request(app)
      .delete(`/plans/${created.body.plan.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});
