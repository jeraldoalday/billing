import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { RecordingWebhookTransport } from '../lib/webhookTransport';
import { verifyWebhookSignature } from '../domain/webhook';
import * as webhookService from '../services/webhook.service';

const app = createApp();

async function resetDb() {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

async function signupAndGetToken(email = 'user@acme.test') {
  const res = await request(app)
    .post('/auth/signup')
    .send({ organizationName: 'Acme Corp', email, password: 'super-secret-1' });
  return res.body.token as string;
}

async function createEndpoint(token: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/webhook-endpoints')
    .set('Authorization', `Bearer ${token}`)
    .send({ url: 'https://hooks.test/billing', ...body });
  return res.body.endpoint as { id: string; secret: string; enabledEvents: string[] };
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

describe('POST /webhook-endpoints', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).post('/webhook-endpoints').send({});

    expect(res.status).toBe(401);
  });

  it('creates an endpoint subscribed to everything by default', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/webhook-endpoints')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://hooks.test/billing', description: 'Primary receiver' });

    expect(res.status).toBe(201);
    expect(res.body.endpoint.enabledEvents).toEqual(['*']);
    expect(res.body.endpoint.active).toBe(true);
    expect(res.body.endpoint.secret).toMatch(/^whsec_/);
  });

  it('rejects a non-http url', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/webhook-endpoints')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'ftp://hooks.test/billing' });

    expect(res.status).toBe(400);
  });

  it('rejects an unknown event pattern', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/webhook-endpoints')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://hooks.test/billing', enabledEvents: ['invoce.*'] });

    expect(res.status).toBe(400);
  });

  it('accepts a namespace wildcard and an exact event type', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/webhook-endpoints')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://hooks.test/billing', enabledEvents: ['invoice.*', 'payment.failed'] });

    expect(res.status).toBe(201);
    expect(res.body.endpoint.enabledEvents).toEqual(['invoice.*', 'payment.failed']);
  });

  it('rejects a duplicate url with 409', async () => {
    const token = await signupAndGetToken();
    await createEndpoint(token);

    const res = await request(app)
      .post('/webhook-endpoints')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://hooks.test/billing' });

    expect(res.status).toBe(409);
  });
});

describe('GET /webhook-endpoints', () => {
  it('masks the signing secret on every read', async () => {
    const token = await signupAndGetToken();
    const created = await createEndpoint(token);

    const listRes = await request(app).get('/webhook-endpoints').set('Authorization', `Bearer ${token}`);
    const getRes = await request(app)
      .get(`/webhook-endpoints/${created.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.body.endpoints[0].secret).not.toBe(created.secret);
    expect(listRes.body.endpoints[0].secret).toMatch(/^whsec_[0-9a-f]{5}\.\.\.[0-9a-f]{4}$/);
    expect(getRes.body.endpoint.secret).toBe(listRes.body.endpoints[0].secret);
  });

  it('filters by active state', async () => {
    const token = await signupAndGetToken();
    const first = await createEndpoint(token);
    await createEndpoint(token, { url: 'https://hooks.test/second' });
    await request(app)
      .patch(`/webhook-endpoints/${first.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ active: false });

    const res = await request(app)
      .get('/webhook-endpoints?active=false')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.endpoints).toHaveLength(1);
    expect(res.body.endpoints[0].id).toBe(first.id);
  });

  it('never returns another organization endpoints', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const created = await createEndpoint(tokenA);
    const tokenB = await signupAndGetToken('b@globex.test');

    const listRes = await request(app).get('/webhook-endpoints').set('Authorization', `Bearer ${tokenB}`);
    const getRes = await request(app)
      .get(`/webhook-endpoints/${created.id}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(listRes.body.endpoints).toHaveLength(0);
    expect(getRes.status).toBe(404);
  });
});

describe('PATCH /webhook-endpoints/:id', () => {
  it('updates the subscription list', async () => {
    const token = await signupAndGetToken();
    const created = await createEndpoint(token);

    const res = await request(app)
      .patch(`/webhook-endpoints/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabledEvents: ['dunning.*'] });

    expect(res.status).toBe(200);
    expect(res.body.endpoint.enabledEvents).toEqual(['dunning.*']);
  });

  it('rejects an empty update', async () => {
    const token = await signupAndGetToken();
    const created = await createEndpoint(token);

    const res = await request(app)
      .patch(`/webhook-endpoints/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejects moving an endpoint onto another endpoint url', async () => {
    const token = await signupAndGetToken();
    const first = await createEndpoint(token);
    await createEndpoint(token, { url: 'https://hooks.test/second' });

    const res = await request(app)
      .patch(`/webhook-endpoints/${first.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://hooks.test/second' });

    expect(res.status).toBe(409);
  });
});

describe('POST /webhook-endpoints/:id/rotate-secret', () => {
  it('returns a new secret in full', async () => {
    const token = await signupAndGetToken();
    const created = await createEndpoint(token);

    const res = await request(app)
      .post(`/webhook-endpoints/${created.id}/rotate-secret`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.endpoint.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(res.body.endpoint.secret).not.toBe(created.secret);
  });

  it('signs later deliveries with the rotated secret', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const token = await signupAndGetToken();
    const created = await createEndpoint(token);
    const rotateRes = await request(app)
      .post(`/webhook-endpoints/${created.id}/rotate-secret`)
      .set('Authorization', `Bearer ${token}`);
    const rotatedSecret = rotateRes.body.endpoint.secret as string;

    const endpointRow = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: created.id } });
    await webhookService.emitEvent(endpointRow.organizationId, 'invoice.created', { invoiceId: 'inv_1' });

    const sent = transport.lastRequest;
    expect(verifyWebhookSignature(rotatedSecret, sent?.payload ?? '', sent?.headers['webhook-signature'] ?? '')).toBe(
      true,
    );
    expect(verifyWebhookSignature(created.secret, sent?.payload ?? '', sent?.headers['webhook-signature'] ?? '')).toBe(
      false,
    );
  });
});

describe('DELETE /webhook-endpoints/:id', () => {
  it('removes the endpoint', async () => {
    const token = await signupAndGetToken();
    const created = await createEndpoint(token);

    const res = await request(app)
      .delete(`/webhook-endpoints/${created.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    const after = await request(app)
      .get(`/webhook-endpoints/${created.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(404);
  });

  it('does not let one organization delete another endpoint', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const created = await createEndpoint(tokenA);
    const tokenB = await signupAndGetToken('b@globex.test');

    const res = await request(app)
      .delete(`/webhook-endpoints/${created.id}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(404);
    await expect(prisma.webhookEndpoint.count()).resolves.toBe(1);
  });
});
