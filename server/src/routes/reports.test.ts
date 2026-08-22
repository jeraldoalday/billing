import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

// Signed up once for the whole file, for the same reason as
// src/routes/coupons.test.ts: /auth/signup is behind a process-wide rate
// limiter, so a file with a signup per test eventually starts collecting
// 429s that have nothing to do with what it tests.
let orgToken: string;
let otherOrgToken: string;

async function resetBillingData() {
  await prisma.couponRedemption.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.invoiceLineItem.deleteMany();
  await prisma.invoice.deleteMany();
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

async function makeSubscription(token: string, flatAmount = 5000, interval = 'MONTH') {
  const customerRes = await request(app)
    .post('/customers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Jane Doe', email: `jane-${Math.random().toString(36).slice(2)}@example.com` });

  const productRes = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `Product ${flatAmount}` });

  const planRes = await request(app).post('/plans').set('Authorization', `Bearer ${token}`).send({
    productId: productRes.body.product.id,
    name: `Plan ${flatAmount}`,
    pricingModel: 'FLAT',
    interval,
    currency: 'usd',
    flatAmount,
  });

  const subscriptionRes = await request(app)
    .post('/subscriptions')
    .set('Authorization', `Bearer ${token}`)
    .send({ customerId: customerRes.body.customer.id, planId: planRes.body.plan.id });

  return subscriptionRes.body.subscription as { id: string; customerId: string };
}

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

describe('GET /reports/mrr', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).get('/reports/mrr');

    expect(res.status).toBe(401);
  });

  it('reports MRR broken down by plan', async () => {
    await makeSubscription(orgToken, 5000);
    await makeSubscription(orgToken, 2500);

    const res = await request(app).get('/reports/mrr').set('Authorization', `Bearer ${orgToken}`);

    expect(res.status).toBe(200);
    expect(res.body.mrr).toBe(7500);
    expect(res.body.subscriptions).toBe(2);
    expect(res.body.groupBy).toBe('plan');
    expect(res.body.breakdown).toHaveLength(2);
    expect(res.body.breakdown[0].mrr).toBe(5000);
  });

  it('groups by interval when asked', async () => {
    await makeSubscription(orgToken, 5000);
    await makeSubscription(orgToken, 120000, 'YEAR');

    const res = await request(app)
      .get('/reports/mrr?groupBy=interval')
      .set('Authorization', `Bearer ${orgToken}`);

    expect(res.body.groupBy).toBe('interval');
    expect(res.body.breakdown.map((entry: { label: string }) => entry.label).sort()).toEqual([
      'MONTH',
      'YEAR',
    ]);
  });

  it('rejects an unknown grouping', async () => {
    const res = await request(app)
      .get('/reports/mrr?groupBy=customer')
      .set('Authorization', `Bearer ${orgToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('reports only the requesting organization revenue', async () => {
    await makeSubscription(otherOrgToken, 9900);

    const res = await request(app).get('/reports/mrr').set('Authorization', `Bearer ${orgToken}`);

    expect(res.body.mrr).toBe(0);
  });

  it('reflects a coupon applied to a subscription', async () => {
    const subscription = await makeSubscription(orgToken, 5000);
    await request(app)
      .post('/coupons')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ code: 'HALFOFF', type: 'PERCENT_OFF', percentOff: 50, duration: 'FOREVER' });
    await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ code: 'HALFOFF' });

    const res = await request(app).get('/reports/mrr').set('Authorization', `Bearer ${orgToken}`);

    expect(res.body.mrr).toBe(2500);
  });
});

describe('GET /reports/arpu', () => {
  it('reports revenue per paying customer', async () => {
    await makeSubscription(orgToken, 5000);
    await makeSubscription(orgToken, 3000);

    const res = await request(app).get('/reports/arpu').set('Authorization', `Bearer ${orgToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ arpu: 4000, mrr: 8000, customers: 2 });
  });

  it('reports zero for an organization with no subscriptions', async () => {
    const res = await request(app).get('/reports/arpu').set('Authorization', `Bearer ${orgToken}`);

    expect(res.body.arpu).toBe(0);
  });
});

describe('GET /reports/churn', () => {
  it('defaults to the last thirty days', async () => {
    const res = await request(app).get('/reports/churn').set('Authorization', `Bearer ${orgToken}`);

    expect(res.status).toBe(200);
    expect(new Date(res.body.to).getTime() - new Date(res.body.from).getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  it('reports the churn rate over an explicit window', async () => {
    const kept = await makeSubscription(orgToken, 5000);
    const lost = await makeSubscription(orgToken, 5000);
    await prisma.subscription.update({
      where: { id: kept.id },
      data: { createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    await prisma.subscription.update({
      where: { id: lost.id },
      data: {
        createdAt: new Date('2026-01-01T00:00:00Z'),
        canceledAt: new Date('2026-02-15T00:00:00Z'),
        status: 'CANCELED',
      },
    });

    const res = await request(app)
      .get('/reports/churn?from=2026-02-01T00:00:00Z&to=2026-03-01T00:00:00Z')
      .set('Authorization', `Bearer ${orgToken}`);

    expect(res.body.subscriptions).toMatchObject({ atStart: 2, churned: 1, churnRate: 50 });
    expect(res.body.customers.churnRate).toBe(50);
  });

  it('rejects a window that ends before it starts', async () => {
    const res = await request(app)
      .get('/reports/churn?from=2026-03-01T00:00:00Z&to=2026-02-01T00:00:00Z')
      .set('Authorization', `Bearer ${orgToken}`);

    expect(res.status).toBe(400);
  });

  it('rejects an unparseable date', async () => {
    const res = await request(app)
      .get('/reports/churn?from=not-a-date')
      .set('Authorization', `Bearer ${orgToken}`);

    expect(res.status).toBe(400);
  });
});

describe('GET /reports/revenue', () => {
  it('reports collected revenue, discounts, and what is still outstanding', async () => {
    const subscription = await makeSubscription(orgToken, 10000);
    await request(app)
      .post('/coupons')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ code: 'TENOFF', type: 'AMOUNT_OFF', amountOff: 1000, currency: 'usd', duration: 'FOREVER' });
    await request(app)
      .post(`/subscriptions/${subscription.id}/coupon`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ code: 'TENOFF' });

    const invoiceRes = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ subscriptionId: subscription.id });
    await request(app)
      .post(`/invoices/${invoiceRes.body.invoice.id}/finalize`)
      .set('Authorization', `Bearer ${orgToken}`);
    await request(app)
      .post(`/invoices/${invoiceRes.body.invoice.id}/pay`)
      .set('Authorization', `Bearer ${orgToken}`);

    const res = await request(app).get('/reports/revenue').set('Authorization', `Bearer ${orgToken}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toBe(1);
    expect(res.body.grossRevenue).toBe(9000);
    expect(res.body.discounts).toBe(1000);
    expect(res.body.outstanding).toBe(0);
  });

  it('reports zero over a window with no activity', async () => {
    const res = await request(app)
      .get('/reports/revenue?from=2020-01-01T00:00:00Z&to=2020-02-01T00:00:00Z')
      .set('Authorization', `Bearer ${orgToken}`);

    expect(res.body).toMatchObject({ invoices: 0, grossRevenue: 0, netRevenue: 0 });
  });
});

describe('GET /reports/summary', () => {
  it('returns MRR, churn, and revenue together', async () => {
    await makeSubscription(orgToken, 5000);

    const res = await request(app).get('/reports/summary').set('Authorization', `Bearer ${orgToken}`);

    expect(res.status).toBe(200);
    expect(res.body.mrr.mrr).toBe(5000);
    expect(res.body.churn.subscriptions.churnRate).toBe(0);
    expect(res.body.revenue.grossRevenue).toBe(0);
  });

  it('rejects requests with no token', async () => {
    const res = await request(app).get('/reports/summary');

    expect(res.status).toBe(401);
  });
});
