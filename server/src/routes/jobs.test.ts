import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { resetJobQueue } from '../services/job.service';

const app = createApp();

// Signed up once for the whole file, for the same reason as
// src/routes/reports.test.ts: /auth/signup is behind a process-wide rate
// limiter, so a file with a signup per test eventually starts collecting
// 429s that have nothing to do with what it tests.
let orgToken: string;
let otherOrgToken: string;

const CARD = {
  succeeds: '4242424242424242',
  hardDeclines: '4000000000000002',
};

async function resetBillingData() {
  await prisma.jobRun.deleteMany();
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

// A subscription whose first billing period has already closed, so a
// billing run against it has something to do. Returns the moment just
// after that period ended, which is the `asOf` every test drives from.
async function makeDueSubscription(token: string, cardNumber: string | null = CARD.succeeds) {
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
    name: 'Pro Monthly',
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency: 'usd',
    flatAmount: 5000,
  });

  const subscriptionRes = await request(app)
    .post('/subscriptions')
    .set('Authorization', `Bearer ${token}`)
    .send({ customerId: customerRes.body.customer.id, planId: planRes.body.plan.id });

  if (cardNumber) {
    await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerId: customerRes.body.customer.id,
        cardNumber,
        expMonth: 12,
        expYear: 2039,
        isDefault: true,
      });
  }

  const subscription = subscriptionRes.body.subscription;
  return {
    subscription,
    asOf: new Date(new Date(subscription.currentPeriodEnd).getTime() + 1_000).toISOString(),
  };
}

beforeAll(async () => {
  await resetDb();
  orgToken = await signupAndGetToken('jobs-owner@example.com');
  otherOrgToken = await signupAndGetToken('jobs-other@example.com');
});

beforeEach(async () => {
  resetJobQueue();
  await resetBillingData();
});

afterAll(async () => {
  resetJobQueue();
  await resetDb();
  await prisma.$disconnect();
});

describe('authentication', () => {
  it('rejects every job route without a token', async () => {
    await request(app).get('/jobs').expect(401);
    await request(app).get('/jobs/queue').expect(401);
    await request(app).get('/jobs/some-id').expect(401);
    await request(app).post('/jobs').send({ name: 'billing.cycle' }).expect(401);
    await request(app).post('/jobs/run').send({}).expect(401);
    await request(app).post('/jobs/billing-run').send({}).expect(401);
  });
});

describe('POST /jobs', () => {
  it('queues a job and answers with the row recording it', async () => {
    const res = await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'billing.cycle' })
      .expect(202);

    expect(res.body.run).toMatchObject({
      name: 'billing.cycle',
      status: 'PENDING',
      attemptsMade: 0,
    });
    expect(JSON.parse(res.body.run.payload)).toMatchObject({ organizationId: expect.any(String) });
  });

  it('accepts an asOf and a limit for the sweep', async () => {
    const res = await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'dunning.sweep', payload: { asOf: '2026-12-01T00:00:00.000Z', limit: 10 } })
      .expect(202);

    expect(JSON.parse(res.body.run.payload)).toMatchObject({
      asOf: '2026-12-01T00:00:00.000Z',
      limit: 10,
    });
  });

  it('rejects a job name it cannot run', async () => {
    const res = await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'invoice.email' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a nonsensical attempt budget', async () => {
    await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'billing.cycle', maxAttempts: 0 })
      .expect(400);
  });

  it('ignores an organization id smuggled in the payload', async () => {
    const res = await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'billing.cycle', payload: { organizationId: 'org_someone_else' } })
      .expect(202);

    expect(JSON.parse(res.body.run.payload).organizationId).not.toBe('org_someone_else');
  });
});

describe('POST /jobs/run', () => {
  it('runs the queued work and reports what settled', async () => {
    const { asOf } = await makeDueSubscription(orgToken);
    await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'billing.cycle', payload: { asOf } })
      .expect(202);

    const res = await request(app)
      .post('/jobs/run')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({})
      .expect(200);

    expect(res.body.ran).toBe(1);
    expect(res.body.runs[0].status).toBe('SUCCEEDED');
    expect(JSON.parse(res.body.runs[0].result)).toMatchObject({ invoicesPaid: 1 });
  });

  it('does not run another organization s queued work', async () => {
    await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${otherOrgToken}`)
      .send({ name: 'billing.cycle' })
      .expect(202);

    const res = await request(app)
      .post('/jobs/run')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({})
      .expect(200);

    expect(res.body.ran).toBe(0);
    const theirs = await request(app)
      .get('/jobs')
      .set('Authorization', `Bearer ${otherOrgToken}`)
      .expect(200);
    expect(theirs.body.runs[0].status).toBe('PENDING');
  });

  it('rejects a limit outside the allowed range', async () => {
    await request(app)
      .post('/jobs/run')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ limit: 5_000 })
      .expect(400);
  });
});

describe('POST /jobs/billing-run', () => {
  it('bills the closed period and answers with the run summary', async () => {
    const { asOf, subscription } = await makeDueSubscription(orgToken);

    const res = await request(app)
      .post('/jobs/billing-run')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ asOf })
      .expect(200);

    expect(res.body).toMatchObject({
      subscriptionsConsidered: 1,
      asOf,
      totals: { renewed: 1, invoicesBilled: 1, invoicesPaid: 1, amountCollected: 5000 },
    });
    expect(res.body.results[0]).toMatchObject({
      subscriptionId: subscription.id,
      outcome: 'RENEWED',
    });

    const invoices = await request(app)
      .get('/invoices')
      .set('Authorization', `Bearer ${orgToken}`)
      .expect(200);
    expect(invoices.body.invoices).toHaveLength(1);
    expect(invoices.body.invoices[0].status).toBe('PAID');
  });

  it('reports a declined renewal without failing the request', async () => {
    const { asOf } = await makeDueSubscription(orgToken, CARD.hardDeclines);

    const res = await request(app)
      .post('/jobs/billing-run')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ asOf })
      .expect(200);

    expect(res.body.totals).toMatchObject({ paymentsFailed: 1, invoicesPaid: 0 });
    const campaigns = await request(app)
      .get('/dunning')
      .set('Authorization', `Bearer ${orgToken}`)
      .expect(200);
    expect(campaigns.body.campaigns).toHaveLength(1);
  });

  it('can be scoped to a single subscription', async () => {
    const first = await makeDueSubscription(orgToken);
    const second = await makeDueSubscription(orgToken);

    const res = await request(app)
      .post('/jobs/billing-run')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ asOf: first.asOf, subscriptionId: first.subscription.id })
      .expect(200);

    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].subscriptionId).toBe(first.subscription.id);

    const invoices = await request(app)
      .get('/invoices')
      .set('Authorization', `Bearer ${orgToken}`)
      .query({ subscriptionId: second.subscription.id })
      .expect(200);
    expect(invoices.body.invoices).toHaveLength(0);
  });

  it('never bills another organization s subscriptions', async () => {
    const theirs = await makeDueSubscription(otherOrgToken);

    const res = await request(app)
      .post('/jobs/billing-run')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ asOf: theirs.asOf })
      .expect(200);

    expect(res.body.subscriptionsConsidered).toBe(0);
    const invoices = await request(app)
      .get('/invoices')
      .set('Authorization', `Bearer ${otherOrgToken}`)
      .expect(200);
    expect(invoices.body.invoices).toHaveLength(0);
  });

  it('rejects an unparseable asOf', async () => {
    await request(app)
      .post('/jobs/billing-run')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ asOf: 'not-a-date' })
      .expect(400);
  });
});

describe('GET /jobs', () => {
  it('lists this organization s runs, newest first', async () => {
    await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'billing.cycle' });
    await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'webhook.retry' });

    const res = await request(app).get('/jobs').set('Authorization', `Bearer ${orgToken}`).expect(200);

    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0].name).toBe('webhook.retry');
  });

  it('filters by name and status', async () => {
    await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'billing.cycle' });
    await request(app).post('/jobs/run').set('Authorization', `Bearer ${orgToken}`).send({});
    await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'webhook.retry' });

    const succeeded = await request(app)
      .get('/jobs')
      .query({ status: 'SUCCEEDED' })
      .set('Authorization', `Bearer ${orgToken}`)
      .expect(200);
    expect(succeeded.body.runs).toHaveLength(1);
    expect(succeeded.body.runs[0].name).toBe('billing.cycle');

    const pending = await request(app)
      .get('/jobs')
      .query({ name: 'webhook.retry' })
      .set('Authorization', `Bearer ${orgToken}`)
      .expect(200);
    expect(pending.body.runs).toHaveLength(1);
  });

  it('rejects a status it does not know', async () => {
    await request(app)
      .get('/jobs')
      .query({ status: 'ALMOST' })
      .set('Authorization', `Bearer ${orgToken}`)
      .expect(400);
  });
});

describe('GET /jobs/:id', () => {
  it('returns one run', async () => {
    const queued = await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'billing.cycle' })
      .expect(202);

    const res = await request(app)
      .get(`/jobs/${queued.body.run.id}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .expect(200);

    expect(res.body.run.id).toBe(queued.body.run.id);
  });

  it('404s another organization s run exactly like a missing one', async () => {
    const queued = await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'billing.cycle' })
      .expect(202);

    await request(app)
      .get(`/jobs/${queued.body.run.id}`)
      .set('Authorization', `Bearer ${otherOrgToken}`)
      .expect(404);
    await request(app)
      .get('/jobs/does-not-exist')
      .set('Authorization', `Bearer ${orgToken}`)
      .expect(404);
  });
});

describe('GET /jobs/queue', () => {
  it('describes what the process can run and what it is holding', async () => {
    await request(app)
      .post('/jobs')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'billing.cycle' });

    const res = await request(app)
      .get('/jobs/queue')
      .set('Authorization', `Bearer ${orgToken}`)
      .expect(200);

    expect(res.body.queue.registered).toEqual(['billing.cycle', 'dunning.sweep', 'webhook.retry']);
    expect(res.body.queue.pending).toBe(1);
    expect(res.body.queue.counts).toMatchObject({ PENDING: 1 });
  });
});
