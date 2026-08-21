import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

const DAY_MS = 24 * 60 * 60 * 1000;

// Card numbers whose last four digits drive src/lib/paymentGateway.ts's
// deterministic mock outcomes.
const CARD = {
  succeeds: '4242424242424242',
  hardDeclines: '4000000000000002',
};

async function resetDb() {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.dunningAttempt.deleteMany();
  await prisma.dunningCampaign.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.paymentMethod.deleteMany();
  await prisma.invoiceLineItem.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

async function signupAndGetToken(email = 'user@acme.test', organizationName = 'Acme Corp') {
  const res = await request(app)
    .post('/auth/signup')
    .send({ organizationName, email, password: 'super-secret-1' });
  return res.body.token as string;
}

// Drives the whole HTTP flow up to a declined charge, which is what puts a
// subscription into dunning in the first place.
async function makePastDueSubscription(token: string, cardNumber = CARD.hardDeclines) {
  const auth = { Authorization: `Bearer ${token}` };

  const customerRes = await request(app)
    .post('/customers')
    .set(auth)
    .send({ name: 'Jane Doe', email: `jane-${Math.random()}@example.com` });
  const productRes = await request(app).post('/products').set(auth).send({ name: 'Pro product' });
  const planRes = await request(app).post('/plans').set(auth).send({
    productId: productRes.body.product.id,
    name: 'Pro Monthly',
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency: 'usd',
    flatAmount: 5000,
  });
  const subscriptionRes = await request(app)
    .post('/subscriptions')
    .set(auth)
    .send({ customerId: customerRes.body.customer.id, planId: planRes.body.plan.id });
  const invoiceRes = await request(app)
    .post('/invoices')
    .set(auth)
    .send({ subscriptionId: subscriptionRes.body.subscription.id });
  await request(app).post(`/invoices/${invoiceRes.body.invoice.id}/finalize`).set(auth);

  const paymentMethodRes = await request(app)
    .post('/payment-methods')
    .set(auth)
    .send({
      customerId: customerRes.body.customer.id,
      cardNumber,
      expMonth: 12,
      expYear: 2039,
      isDefault: true,
    });

  const chargeRes = await request(app)
    .post(`/invoices/${invoiceRes.body.invoice.id}/charge`)
    .set(auth)
    .send({ paymentMethodId: paymentMethodRes.body.paymentMethod.id });

  return {
    customerId: customerRes.body.customer.id as string,
    subscriptionId: subscriptionRes.body.subscription.id as string,
    invoiceId: invoiceRes.body.invoice.id as string,
    paymentStatus: chargeRes.body.payment.status as string,
  };
}

async function addSucceedingCard(token: string, customerId: string) {
  return request(app)
    .post('/payment-methods')
    .set('Authorization', `Bearer ${token}`)
    .send({ customerId, cardNumber: CARD.succeeds, expMonth: 12, expYear: 2039, isDefault: true });
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('GET /dunning', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).get('/dunning');

    expect(res.status).toBe(401);
  });

  it('lists the campaign opened by a declined charge', async () => {
    const token = await signupAndGetToken();
    const { invoiceId, subscriptionId, paymentStatus } = await makePastDueSubscription(token);

    expect(paymentStatus).toBe('FAILED');

    const res = await request(app).get('/dunning').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0]).toMatchObject({
      invoiceId,
      subscriptionId,
      status: 'SCHEDULED',
      attemptsMade: 0,
      lastFailureCode: 'card_declined',
    });
  });

  it('filters by status', async () => {
    const token = await signupAndGetToken();
    await makePastDueSubscription(token);

    const scheduled = await request(app)
      .get('/dunning?status=SCHEDULED')
      .set('Authorization', `Bearer ${token}`);
    const recovered = await request(app)
      .get('/dunning?status=RECOVERED')
      .set('Authorization', `Bearer ${token}`);

    expect(scheduled.body.campaigns).toHaveLength(1);
    expect(recovered.body.campaigns).toHaveLength(0);
  });

  it('rejects an unknown status filter', async () => {
    const token = await signupAndGetToken();

    const res = await request(app).get('/dunning?status=NOPE').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it('never returns another organization campaigns', async () => {
    const tokenA = await signupAndGetToken('a@acme.test', 'Acme Corp');
    await makePastDueSubscription(tokenA);
    const tokenB = await signupAndGetToken('b@globex.test', 'Globex');

    const res = await request(app).get('/dunning').set('Authorization', `Bearer ${tokenB}`);

    expect(res.body.campaigns).toHaveLength(0);
  });
});

describe('GET /dunning/:id', () => {
  it('includes the attempt history', async () => {
    const token = await signupAndGetToken();
    await makePastDueSubscription(token);
    const listRes = await request(app).get('/dunning').set('Authorization', `Bearer ${token}`);
    const campaignId = listRes.body.campaigns[0].id as string;

    await request(app).post(`/dunning/${campaignId}/retry`).set('Authorization', `Bearer ${token}`);

    const res = await request(app).get(`/dunning/${campaignId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.campaign.attempts).toHaveLength(1);
    expect(res.body.campaign.attempts[0].outcome).toBe('FAILED');
  });

  it('404s for another organization campaign', async () => {
    const tokenA = await signupAndGetToken('a@acme.test', 'Acme Corp');
    await makePastDueSubscription(tokenA);
    const listRes = await request(app).get('/dunning').set('Authorization', `Bearer ${tokenA}`);
    const tokenB = await signupAndGetToken('b@globex.test', 'Globex');

    const res = await request(app)
      .get(`/dunning/${listRes.body.campaigns[0].id}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(404);
  });
});

describe('POST /dunning/:id/retry', () => {
  it('retries immediately, ignoring the schedule', async () => {
    const token = await signupAndGetToken();
    const { customerId } = await makePastDueSubscription(token);
    const listRes = await request(app).get('/dunning').set('Authorization', `Bearer ${token}`);
    const campaignId = listRes.body.campaigns[0].id as string;
    await addSucceedingCard(token, customerId);

    const res = await request(app)
      .post(`/dunning/${campaignId}/retry`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('SUCCEEDED');
    expect(res.body.campaign.status).toBe('RECOVERED');
  });

  it('409s once the campaign has resolved', async () => {
    const token = await signupAndGetToken();
    await makePastDueSubscription(token);
    const listRes = await request(app).get('/dunning').set('Authorization', `Bearer ${token}`);
    const campaignId = listRes.body.campaigns[0].id as string;
    await request(app).post(`/dunning/${campaignId}/cancel`).set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .post(`/dunning/${campaignId}/retry`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
  });
});

describe('POST /dunning/run', () => {
  it('runs nothing before the first retry is due', async () => {
    const token = await signupAndGetToken();
    await makePastDueSubscription(token);

    const res = await request(app).post('/dunning/run').set('Authorization', `Bearer ${token}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(0);
  });

  it('runs the whole schedule and cancels the subscription when it runs out', async () => {
    const token = await signupAndGetToken();
    const { subscriptionId } = await makePastDueSubscription(token);

    const pastDue = await request(app)
      .get(`/subscriptions/${subscriptionId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(pastDue.body.subscription.status).toBe('PAST_DUE');

    let lastRes;
    for (const day of [1, 3, 7]) {
      // eslint-disable-next-line no-await-in-loop -- each sweep must observe the previous one's state
      lastRes = await request(app)
        .post('/dunning/run')
        .set('Authorization', `Bearer ${token}`)
        .send({ asOf: new Date(Date.now() + day * DAY_MS).toISOString() });
      expect(lastRes.status).toBe(200);
      expect(lastRes.body.campaigns).toHaveLength(1);
    }

    expect(lastRes?.body.campaigns[0].status).toBe('EXHAUSTED');
    expect(lastRes?.body.campaigns[0].attemptsMade).toBe(3);

    const canceled = await request(app)
      .get(`/subscriptions/${subscriptionId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(canceled.body.subscription.status).toBe('CANCELED');
  });

  it('recovers the subscription when a retry succeeds', async () => {
    const token = await signupAndGetToken();
    const { customerId, subscriptionId, invoiceId } = await makePastDueSubscription(token);
    await addSucceedingCard(token, customerId);

    const res = await request(app)
      .post('/dunning/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ asOf: new Date(Date.now() + DAY_MS).toISOString() });

    expect(res.body.campaigns[0].status).toBe('RECOVERED');

    const subscriptionRes = await request(app)
      .get(`/subscriptions/${subscriptionId}`)
      .set('Authorization', `Bearer ${token}`);
    const invoiceRes = await request(app)
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(subscriptionRes.body.subscription.status).toBe('ACTIVE');
    expect(invoiceRes.body.invoice.status).toBe('PAID');
  });

  it('rejects a limit outside the allowed range', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/dunning/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ limit: 0 });

    expect(res.status).toBe(400);
  });
});

describe('POST /dunning/:id/cancel', () => {
  it('resolves the campaign but leaves the subscription past due', async () => {
    const token = await signupAndGetToken();
    const { subscriptionId } = await makePastDueSubscription(token);
    const listRes = await request(app).get('/dunning').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .post(`/dunning/${listRes.body.campaigns[0].id}/cancel`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe('CANCELED');

    const subscriptionRes = await request(app)
      .get(`/subscriptions/${subscriptionId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(subscriptionRes.body.subscription.status).toBe('PAST_DUE');
  });

  it('404s for another organization campaign', async () => {
    const tokenA = await signupAndGetToken('a@acme.test', 'Acme Corp');
    await makePastDueSubscription(tokenA);
    const listRes = await request(app).get('/dunning').set('Authorization', `Bearer ${tokenA}`);
    const tokenB = await signupAndGetToken('b@globex.test', 'Globex');

    const res = await request(app)
      .post(`/dunning/${listRes.body.campaigns[0].id}/cancel`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(404);
  });
});
