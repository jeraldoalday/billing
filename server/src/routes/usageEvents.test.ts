import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

async function resetDb() {
  await prisma.usageEvent.deleteMany();
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
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

async function makeUsageSubscription(token: string, metric = 'api_calls') {
  const customerRes = await request(app)
    .post('/customers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Jane Doe', email: `jane-${Date.now()}-${Math.random()}@example.com` });

  const productRes = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Metered product' });

  const planRes = await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
    productId: productRes.body.product.id,
    name: 'Metered API',
    pricingModel: 'USAGE',
    interval: 'MONTH',
    currency: 'usd',
    usageMetric: metric,
    usageUnitAmount: 2,
  });

  const subscriptionRes = await request(app)
    .post('/subscriptions')
    .set('Authorization', `Bearer ${token}`)
    .send({ customerId: customerRes.body.customer.id, planId: planRes.body.plan.id });

  return subscriptionRes.body.subscription as { id: string };
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('POST /usage-events', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).post('/usage-events').send({});

    expect(res.status).toBe(401);
  });

  it('records a usage event for a subscription', async () => {
    const token = await signupAndGetToken();
    const subscription = await makeUsageSubscription(token);

    const res = await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscriptionId: subscription.id, metric: 'api_calls', quantity: 50 });

    expect(res.status).toBe(201);
    expect(res.body.usageEvent.quantity).toBe(50);
    expect(res.body.usageEvent.metric).toBe('api_calls');
    expect(res.body.usageEvent.subscriptionId).toBe(subscription.id);
  });

  it('rejects a non-positive quantity with 400', async () => {
    const token = await signupAndGetToken();
    const subscription = await makeUsageSubscription(token);

    const res = await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscriptionId: subscription.id, metric: 'api_calls', quantity: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for a subscription belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const subscriptionB = await makeUsageSubscription(tokenB);

    const res = await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ subscriptionId: subscriptionB.id, metric: 'api_calls', quantity: 1 });

    expect(res.status).toBe(404);
  });

  it('returns 409 for a duplicate idempotency key on the same subscription', async () => {
    const token = await signupAndGetToken();
    const subscription = await makeUsageSubscription(token);
    await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subscriptionId: subscription.id,
        metric: 'api_calls',
        quantity: 1,
        idempotencyKey: 'req-1',
      });

    const res = await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subscriptionId: subscription.id,
        metric: 'api_calls',
        quantity: 1,
        idempotencyKey: 'req-1',
      });

    expect(res.status).toBe(409);
  });
});

describe('GET /usage-events', () => {
  it('only lists usage events belonging to the caller organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const subscriptionA = await makeUsageSubscription(tokenA);
    const subscriptionB = await makeUsageSubscription(tokenB);
    await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ subscriptionId: subscriptionA.id, metric: 'api_calls', quantity: 1 });
    await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ subscriptionId: subscriptionB.id, metric: 'api_calls', quantity: 1 });

    const res = await request(app).get('/usage-events').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.usageEvents).toHaveLength(1);
  });

  it('filters by metric', async () => {
    const token = await signupAndGetToken();
    const subscription = await makeUsageSubscription(token);
    await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscriptionId: subscription.id, metric: 'api_calls', quantity: 1 });
    await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscriptionId: subscription.id, metric: 'storage_gb', quantity: 3 });

    const res = await request(app)
      .get('/usage-events')
      .query({ metric: 'storage_gb' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.usageEvents).toHaveLength(1);
    expect(res.body.usageEvents[0].metric).toBe('storage_gb');
  });
});

describe('GET /subscriptions/:id/usage', () => {
  it('summarizes current-period usage grouped by metric', async () => {
    const token = await signupAndGetToken();
    const subscription = await makeUsageSubscription(token);
    await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscriptionId: subscription.id, metric: 'api_calls', quantity: 4 });
    await request(app)
      .post('/usage-events')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscriptionId: subscription.id, metric: 'api_calls', quantity: 6 });

    const res = await request(app)
      .get(`/subscriptions/${subscription.id}/usage`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.usage).toEqual([{ metric: 'api_calls', quantity: 10 }]);
  });

  it('returns 404 for a subscription belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const subscriptionB = await makeUsageSubscription(tokenB);

    const res = await request(app)
      .get(`/subscriptions/${subscriptionB.id}/usage`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});
