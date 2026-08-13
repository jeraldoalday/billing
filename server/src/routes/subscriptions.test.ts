import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

async function resetDb() {
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

async function createCustomerAs(token: string, email = 'jane@example.com') {
  const res = await request(app)
    .post('/customers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Jane Doe', email });
  return res.body.customer.id as string;
}

async function createFlatPlanAs(token: string, name: string, flatAmount: number) {
  const productRes = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `${name} product` });
  const planRes = await request(app)
    .post('/plans')
    .set('Authorization', `Bearer ${token}`)
    .send({
      productId: productRes.body.product.id,
      name,
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount,
    });
  return planRes.body.plan.id as string;
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('POST /subscriptions', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).post('/subscriptions').send({});

    expect(res.status).toBe(401);
  });

  it('creates an active subscription', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);

    const res = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, planId });

    expect(res.status).toBe(201);
    expect(res.body.subscription.status).toBe('ACTIVE');
    expect(res.body.subscription.plan.id).toBe(planId);
    expect(res.body.subscription.customer.id).toBe(customerId);
  });

  it('creates a trialing subscription when trialDays is given', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);

    const res = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, planId, trialDays: 14 });

    expect(res.status).toBe(201);
    expect(res.body.subscription.status).toBe('TRIALING');
    expect(res.body.subscription.trialEnd).not.toBeNull();
  });

  it('returns 404 when the customer belongs to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const customerIdB = await createCustomerAs(tokenB, 'b-cust@example.com');
    const planIdA = await createFlatPlanAs(tokenA, 'Pro Monthly', 2900);

    const res = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerId: customerIdB, planId: planIdA });

    expect(res.status).toBe(404);
  });
});

describe('GET /subscriptions', () => {
  it('only lists subscriptions belonging to the caller organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const customerIdA = await createCustomerAs(tokenA, 'a-cust@example.com');
    const customerIdB = await createCustomerAs(tokenB, 'b-cust@example.com');
    const planIdA = await createFlatPlanAs(tokenA, 'A Plan', 1000);
    const planIdB = await createFlatPlanAs(tokenB, 'B Plan', 1000);
    await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerId: customerIdA, planId: planIdA });
    await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ customerId: customerIdB, planId: planIdB });

    const res = await request(app).get('/subscriptions').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
  });
});

describe('POST /subscriptions/:id/cancel', () => {
  it('cancels a subscription immediately by default', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);
    const created = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, planId });

    const res = await request(app)
      .post(`/subscriptions/${created.body.subscription.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe('CANCELED');
  });

  it('schedules a cancellation at period end', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);
    const created = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, planId });

    const res = await request(app)
      .post(`/subscriptions/${created.body.subscription.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ atPeriodEnd: true });

    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe('ACTIVE');
    expect(res.body.subscription.cancelAt).not.toBeNull();
  });

  it('returns 404 when canceling a subscription belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const customerIdB = await createCustomerAs(tokenB, 'b-cust@example.com');
    const planIdB = await createFlatPlanAs(tokenB, 'B Plan', 1000);
    const created = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ customerId: customerIdB, planId: planIdB });

    const res = await request(app)
      .post(`/subscriptions/${created.body.subscription.id}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});

    expect(res.status).toBe(404);
  });
});

describe('PATCH /subscriptions/:id/plan', () => {
  it('switches plans and returns a proration', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const basicPlanId = await createFlatPlanAs(token, 'Basic', 1000);
    const proPlanId = await createFlatPlanAs(token, 'Pro', 5000);
    const created = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, planId: basicPlanId });

    const res = await request(app)
      .patch(`/subscriptions/${created.body.subscription.id}/plan`)
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: proPlanId });

    expect(res.status).toBe(200);
    expect(res.body.subscription.plan.id).toBe(proPlanId);
    expect(res.body.proration).toBeDefined();
    expect(typeof res.body.proration.netAmount).toBe('number');
  });

  it('rejects switching to the same plan with 400', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);
    const created = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, planId });

    const res = await request(app)
      .patch(`/subscriptions/${created.body.subscription.id}/plan`)
      .set('Authorization', `Bearer ${token}`)
      .send({ planId });

    expect(res.status).toBe(400);
  });
});

describe('POST /subscriptions/:id/trial/end', () => {
  it('ends a trial and activates the subscription', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);
    const created = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, planId, trialDays: 14 });

    const res = await request(app)
      .post(`/subscriptions/${created.body.subscription.id}/trial/end`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe('ACTIVE');
  });

  it('rejects ending the trial of a subscription that is not trialing', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);
    const created = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, planId });

    const res = await request(app)
      .post(`/subscriptions/${created.body.subscription.id}/trial/end`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});
