import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

// Two organizations are signed up once for the whole file rather than per
// test, and the reset between tests clears only the billing data they own.
// /auth/signup is behind a module-level rate limiter (see
// src/middleware/rateLimit.ts) whose bucket is shared by every request in
// this process, so a file with a test per signup eventually starts getting
// 429s and failing for reasons that have nothing to do with what it tests.
// Access tokens are stateless JWTs, so they keep working across resets as
// long as the organization they name still exists.
let orgToken: string;
let otherOrgToken: string;

async function resetBillingData() {
  await prisma.couponRedemption.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.product.deleteMany();
}

async function resetDb() {
  await resetBillingData();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

async function signupAndGetToken(email: string) {
  const res = await request(app)
    .post('/auth/signup')
    .send({ organizationName: 'Acme Corp', email, password: 'super-secret-1' });
  return res.body.token as string;
}

async function createCoupon(token: string, body: Record<string, unknown>) {
  return request(app).post('/coupons').set('Authorization', `Bearer ${token}`).send(body);
}

async function makeSubscription(token: string, currency = 'usd') {
  const customerRes = await request(app)
    .post('/customers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Jane Doe', email: `jane-${Math.random().toString(36).slice(2)}@example.com` });

  const productRes = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Pro product' });

  const planRes = await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
    productId: productRes.body.product.id,
    name: 'Pro',
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency,
    flatAmount: 5000,
  });

  const subscriptionRes = await request(app)
    .post('/subscriptions')
    .set('Authorization', `Bearer ${token}`)
    .send({ customerId: customerRes.body.customer.id, planId: planRes.body.plan.id });

  return subscriptionRes.body.subscription as { id: string };
}

const PERCENT_COUPON = {
  code: 'SAVE20',
  type: 'PERCENT_OFF',
  percentOff: 20,
  duration: 'FOREVER',
};

beforeAll(async () => {
  await resetDb();
  orgToken = await signupAndGetToken('user@acme.test');
  otherOrgToken = await signupAndGetToken('other@other.test');
});

beforeEach(resetBillingData);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('POST /coupons', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).post('/coupons').send(PERCENT_COUPON);

    expect(res.status).toBe(401);
  });

  it('creates a percent-off coupon', async () => {
    const token = orgToken;

    const res = await createCoupon(token, PERCENT_COUPON);

    expect(res.status).toBe(201);
    expect(res.body.coupon.code).toBe('SAVE20');
    expect(res.body.coupon.percentOff).toBe(20);
    expect(res.body.coupon.timesRedeemed).toBe(0);
  });

  it('uppercases the code so lookups are case-insensitive', async () => {
    const token = orgToken;

    const res = await createCoupon(token, { ...PERCENT_COUPON, code: 'save20' });

    expect(res.body.coupon.code).toBe('SAVE20');
  });

  it('rejects a percent-off coupon with no percentage', async () => {
    const token = orgToken;

    const res = await createCoupon(token, { code: 'SAVE20', type: 'PERCENT_OFF', duration: 'ONCE' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a percentage above 100', async () => {
    const token = orgToken;

    const res = await createCoupon(token, { ...PERCENT_COUPON, percentOff: 120 });

    expect(res.status).toBe(400);
  });

  it('rejects an amount-off coupon with no currency', async () => {
    const token = orgToken;

    const res = await createCoupon(token, {
      code: 'TENOFF',
      type: 'AMOUNT_OFF',
      amountOff: 1000,
      duration: 'ONCE',
    });

    expect(res.status).toBe(400);
  });

  it('rejects a coupon that mixes both discount shapes', async () => {
    const token = orgToken;

    const res = await createCoupon(token, { ...PERCENT_COUPON, amountOff: 500 });

    expect(res.status).toBe(400);
  });

  it('rejects a repeating coupon with no month count', async () => {
    const token = orgToken;

    const res = await createCoupon(token, { ...PERCENT_COUPON, duration: 'REPEATING' });

    expect(res.status).toBe(400);
  });

  it('rejects a month count on a non-repeating coupon', async () => {
    const token = orgToken;

    const res = await createCoupon(token, { ...PERCENT_COUPON, durationInMonths: 3 });

    expect(res.status).toBe(400);
  });

  it('rejects a code with unusable characters', async () => {
    const token = orgToken;

    const res = await createCoupon(token, { ...PERCENT_COUPON, code: 'save 20%' });

    expect(res.status).toBe(400);
  });

  it('returns 409 for a duplicate code', async () => {
    const token = orgToken;
    await createCoupon(token, PERCENT_COUPON);

    const res = await createCoupon(token, PERCENT_COUPON);

    expect(res.status).toBe(409);
  });
});

describe('GET /coupons', () => {
  it('lists the organization coupons only', async () => {
    const tokenA = orgToken;
    const tokenB = otherOrgToken;
    await createCoupon(tokenA, PERCENT_COUPON);
    await createCoupon(tokenB, { ...PERCENT_COUPON, code: 'OTHER' });

    const res = await request(app).get('/coupons').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.coupons).toHaveLength(1);
    expect(res.body.coupons[0].code).toBe('SAVE20');
  });

  it('filters by active state', async () => {
    const token = orgToken;
    await createCoupon(token, PERCENT_COUPON);
    await createCoupon(token, { ...PERCENT_COUPON, code: 'RETIRED', active: false });

    const res = await request(app)
      .get('/coupons?active=false')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.coupons).toHaveLength(1);
    expect(res.body.coupons[0].code).toBe('RETIRED');
  });

  it('returns 404 for another organization coupon', async () => {
    const tokenA = orgToken;
    const tokenB = otherOrgToken;
    const created = await createCoupon(tokenB, PERCENT_COUPON);

    const res = await request(app)
      .get(`/coupons/${created.body.coupon.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});

describe('PATCH /coupons/:id', () => {
  it('deactivates a coupon', async () => {
    const token = orgToken;
    const created = await createCoupon(token, PERCENT_COUPON);

    const res = await request(app)
      .patch(`/coupons/${created.body.coupon.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ active: false });

    expect(res.status).toBe(200);
    expect(res.body.coupon.active).toBe(false);
  });

  it('rejects an empty update', async () => {
    const token = orgToken;
    const created = await createCoupon(token, PERCENT_COUPON);

    const res = await request(app)
      .patch(`/coupons/${created.body.coupon.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('ignores an attempt to change the discount itself', async () => {
    const token = orgToken;
    const created = await createCoupon(token, PERCENT_COUPON);

    const res = await request(app)
      .patch(`/coupons/${created.body.coupon.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ active: true, percentOff: 90 });

    expect(res.status).toBe(200);
    expect(res.body.coupon.percentOff).toBe(20);
  });
});

describe('DELETE /coupons/:id', () => {
  it('deletes an unredeemed coupon', async () => {
    const token = orgToken;
    const created = await createCoupon(token, PERCENT_COUPON);

    const res = await request(app)
      .delete(`/coupons/${created.body.coupon.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
  });

  it('returns 409 for a coupon that has been redeemed', async () => {
    const token = orgToken;
    const created = await createCoupon(token, PERCENT_COUPON);
    const subscription = await makeSubscription(token);
    await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE20' });

    const res = await request(app)
      .delete(`/coupons/${created.body.coupon.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
  });
});

describe('POST /subscriptions/:id/coupon', () => {
  it('redeems a coupon against a subscription', async () => {
    const token = orgToken;
    await createCoupon(token, PERCENT_COUPON);
    const subscription = await makeSubscription(token);

    const res = await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'save20' });

    expect(res.status).toBe(201);
    expect(res.body.redemption.status).toBe('ACTIVE');
    expect(res.body.redemption.coupon.percentOff).toBe(20);
  });

  it('returns 404 for a code the organization does not have', async () => {
    const token = orgToken;
    const subscription = await makeSubscription(token);

    const res = await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'NOSUCHCODE' });

    expect(res.status).toBe(404);
  });

  it('returns 409 when a coupon is already applied', async () => {
    const token = orgToken;
    await createCoupon(token, PERCENT_COUPON);
    const subscription = await makeSubscription(token);
    await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE20' });

    const res = await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE20' });

    expect(res.status).toBe(409);
  });

  it('returns 404 for another organization subscription', async () => {
    const tokenA = orgToken;
    const tokenB = otherOrgToken;
    await createCoupon(tokenA, PERCENT_COUPON);
    const subscriptionB = await makeSubscription(tokenB);

    const res = await request(app)
      .post(`/subscriptions/${subscriptionB.id}/coupon`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: 'SAVE20' });

    expect(res.status).toBe(404);
  });
});

describe('GET and DELETE /subscriptions/:id/coupon', () => {
  it('reports the coupon currently discounting a subscription', async () => {
    const token = orgToken;
    await createCoupon(token, PERCENT_COUPON);
    const subscription = await makeSubscription(token);
    await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE20' });

    const res = await request(app)
      .get(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.redemption.coupon.code).toBe('SAVE20');
  });

  it('reports null when no coupon is applied', async () => {
    const token = orgToken;
    const subscription = await makeSubscription(token);

    const res = await request(app)
      .get(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.redemption).toBeNull();
  });

  it('removes an applied coupon', async () => {
    const token = orgToken;
    await createCoupon(token, PERCENT_COUPON);
    const subscription = await makeSubscription(token);
    await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE20' });

    const res = await request(app)
      .delete(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.redemption.status).toBe('REMOVED');
  });

  it('returns 404 when there is no coupon to remove', async () => {
    const token = orgToken;
    const subscription = await makeSubscription(token);

    const res = await request(app)
      .delete(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe('GET /coupons/redemptions', () => {
  it('lists redemptions without being shadowed by the :id route', async () => {
    const token = orgToken;
    await createCoupon(token, PERCENT_COUPON);
    const subscription = await makeSubscription(token);
    await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE20' });

    const res = await request(app).get('/coupons/redemptions').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.redemptions).toHaveLength(1);
    expect(res.body.redemptions[0].subscriptionId).toBe(subscription.id);
  });

  it('filters redemptions by subscription', async () => {
    const token = orgToken;
    await createCoupon(token, PERCENT_COUPON);
    const discounted = await makeSubscription(token);
    const plain = await makeSubscription(token);
    await request(app)
      .post(`/subscriptions/${discounted.id}/coupon`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE20' });

    const res = await request(app)
      .get(`/coupons/redemptions?subscriptionId=${plain.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.redemptions).toHaveLength(0);
  });
});
