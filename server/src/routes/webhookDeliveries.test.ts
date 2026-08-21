import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { RecordingWebhookTransport } from '../lib/webhookTransport';
import * as webhookService from '../services/webhook.service';

const app = createApp();

async function resetDb() {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
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

async function signupAndGetToken(email = 'user@acme.test') {
  const res = await request(app)
    .post('/auth/signup')
    .send({ organizationName: 'Acme Corp', email, password: 'super-secret-1' });
  return res.body.token as string;
}

async function orgIdForToken(token: string) {
  const res = await request(app).get('/webhook-endpoints').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const endpoint = await prisma.webhookEndpoint.findFirstOrThrow();
  return endpoint.organizationId;
}

// Registers an endpoint through the API, then emits one event to it so the
// delivery log has something in it.
async function seedDelivery(token: string, transport: RecordingWebhookTransport) {
  webhookService.setWebhookTransport(transport);
  await request(app)
    .post('/webhook-endpoints')
    .set('Authorization', `Bearer ${token}`)
    .send({ url: 'https://hooks.test/billing', enabledEvents: ['*'] });

  const organizationId = await orgIdForToken(token);
  const [delivery] = await webhookService.emitEvent(organizationId, 'invoice.created', {
    invoiceId: 'inv_1',
  });
  return { organizationId, delivery };
}

const originalTransport = webhookService.getWebhookTransport();

beforeEach(resetDb);
afterEach(() => {
  webhookService.setWebhookTransport(originalTransport);
});
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('GET /webhook-deliveries', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).get('/webhook-deliveries');

    expect(res.status).toBe(401);
  });

  it('lists deliveries newest first', async () => {
    const token = await signupAndGetToken();
    const { organizationId } = await seedDelivery(token, new RecordingWebhookTransport());
    await webhookService.emitEvent(organizationId, 'invoice.paid', { invoiceId: 'inv_1' });

    const res = await request(app).get('/webhook-deliveries').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(2);
    expect(res.body.deliveries[0].eventType).toBe('invoice.paid');
  });

  it('filters by event type and status', async () => {
    const token = await signupAndGetToken();
    const { organizationId } = await seedDelivery(token, new RecordingWebhookTransport());
    await webhookService.emitEvent(organizationId, 'invoice.paid', {});

    const byType = await request(app)
      .get('/webhook-deliveries?eventType=invoice.paid')
      .set('Authorization', `Bearer ${token}`);
    const byStatus = await request(app)
      .get('/webhook-deliveries?status=FAILED')
      .set('Authorization', `Bearer ${token}`);

    expect(byType.body.deliveries).toHaveLength(1);
    expect(byStatus.body.deliveries).toHaveLength(0);
  });

  it('rejects an unknown status filter', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .get('/webhook-deliveries?status=NOPE')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it('never returns another organization deliveries', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const { delivery } = await seedDelivery(tokenA, new RecordingWebhookTransport());
    const tokenB = await signupAndGetToken('b@globex.test');

    const listRes = await request(app).get('/webhook-deliveries').set('Authorization', `Bearer ${tokenB}`);
    const getRes = await request(app)
      .get(`/webhook-deliveries/${delivery?.id}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(listRes.body.deliveries).toHaveLength(0);
    expect(getRes.status).toBe(404);
  });
});

describe('GET /webhook-deliveries/:id', () => {
  it('returns the stored payload and attempt state', async () => {
    const token = await signupAndGetToken();
    const { delivery } = await seedDelivery(token, new RecordingWebhookTransport());

    const res = await request(app)
      .get(`/webhook-deliveries/${delivery?.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.delivery.status).toBe('SUCCEEDED');
    expect(res.body.delivery.attemptsMade).toBe(1);
    expect(JSON.parse(res.body.delivery.payload)).toMatchObject({
      type: 'invoice.created',
      data: { invoiceId: 'inv_1' },
    });
  });
});

describe('POST /webhook-deliveries/:id/redeliver', () => {
  it('sends a copy of the original payload', async () => {
    const token = await signupAndGetToken();
    const transport = new RecordingWebhookTransport();
    const { delivery } = await seedDelivery(token, transport);

    const res = await request(app)
      .post(`/webhook-deliveries/${delivery?.id}/redeliver`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(201);
    expect(res.body.delivery.id).not.toBe(delivery?.id);
    expect(res.body.delivery.payload).toBe(delivery?.payload);
    expect(transport.requests).toHaveLength(2);
  });

  it('404s for an unknown delivery', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/webhook-deliveries/does-not-exist/redeliver')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe('POST /webhook-deliveries/retry-due', () => {
  it('re-attempts a failed delivery whose backoff has elapsed', async () => {
    const token = await signupAndGetToken();
    let failing = true;
    const transport = new RecordingWebhookTransport(() =>
      failing ? { ok: false, status: 500, error: 'boom' } : { ok: true, status: 200 },
    );
    const { delivery } = await seedDelivery(token, transport);

    expect(delivery?.status).toBe('PENDING');

    // The first attempt scheduled a retry 30s out, so make it due.
    await prisma.webhookDelivery.update({
      where: { id: delivery?.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    failing = false;

    const res = await request(app)
      .post('/webhook-deliveries/retry-due')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0].status).toBe('SUCCEEDED');
    expect(res.body.deliveries[0].attemptsMade).toBe(2);
  });

  it('returns nothing when no delivery is due', async () => {
    const token = await signupAndGetToken();
    await seedDelivery(token, new RecordingWebhookTransport());

    const res = await request(app)
      .post('/webhook-deliveries/retry-due')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(0);
  });
});

describe('billing actions emit webhooks end to end', () => {
  it('delivers subscription.created when a subscription is created over HTTP', async () => {
    const token = await signupAndGetToken();
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    await request(app)
      .post('/webhook-endpoints')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://hooks.test/billing', enabledEvents: ['subscription.*', 'invoice.*'] });

    const customerRes = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Doe', email: 'jane@example.com' });
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
    const invoiceRes = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscriptionId: subscriptionRes.body.subscription.id });
    await request(app)
      .post(`/invoices/${invoiceRes.body.invoice.id}/finalize`)
      .set('Authorization', `Bearer ${token}`);

    const types = transport.requests.map(
      (req) => (JSON.parse(req.payload) as { type: string }).type,
    );
    expect(types).toEqual(['subscription.created', 'invoice.created', 'invoice.finalized']);
  });
});
