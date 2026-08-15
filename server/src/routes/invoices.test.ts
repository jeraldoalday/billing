import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

async function resetDb() {
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

async function createCustomerAs(token: string, email = 'jane@example.com', country?: string) {
  const res = await request(app)
    .post('/customers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Jane Doe', email, country });
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

async function createSubscriptionAs(token: string, customerId: string, planId: string) {
  const res = await request(app)
    .post('/subscriptions')
    .set('Authorization', `Bearer ${token}`)
    .send({ customerId, planId });
  return res.body.subscription.id as string;
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('POST /invoices', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).post('/invoices').send({});

    expect(res.status).toBe(401);
  });

  it('generates a DRAFT invoice for a subscription', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);
    const subscriptionId = await createSubscriptionAs(token, customerId, planId);

    const res = await request(app).post('/invoices').set('Authorization', `Bearer ${token}`).send({ subscriptionId });

    expect(res.status).toBe(201);
    expect(res.body.invoice.status).toBe('DRAFT');
    expect(res.body.invoice.number).toBe('INV-000001');
    expect(res.body.invoice.total).toBe(2900);
    expect(res.body.invoice.lineItems).toHaveLength(1);
  });

  it('applies tax for a customer with a country on file', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token, 'jane@example.com', 'DE');
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 10000);
    const subscriptionId = await createSubscriptionAs(token, customerId, planId);

    const res = await request(app).post('/invoices').set('Authorization', `Bearer ${token}`).send({ subscriptionId });

    expect(res.status).toBe(201);
    expect(res.body.invoice.taxAmount).toBe(1900);
    expect(res.body.invoice.total).toBe(11900);
  });

  it('returns 409 when an invoice already exists for the current period', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);
    const subscriptionId = await createSubscriptionAs(token, customerId, planId);
    await request(app).post('/invoices').set('Authorization', `Bearer ${token}`).send({ subscriptionId });

    const res = await request(app).post('/invoices').set('Authorization', `Bearer ${token}`).send({ subscriptionId });

    expect(res.status).toBe(409);
  });

  it('returns 404 when the subscription belongs to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const customerIdB = await createCustomerAs(tokenB, 'b-cust@example.com');
    const planIdB = await createFlatPlanAs(tokenB, 'Pro Monthly', 2900);
    const subscriptionIdB = await createSubscriptionAs(tokenB, customerIdB, planIdB);

    const res = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ subscriptionId: subscriptionIdB });

    expect(res.status).toBe(404);
  });
});

describe('GET /invoices', () => {
  it('only lists invoices belonging to the caller organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const customerIdA = await createCustomerAs(tokenA, 'a-cust@example.com');
    const customerIdB = await createCustomerAs(tokenB, 'b-cust@example.com');
    const planIdA = await createFlatPlanAs(tokenA, 'A Plan', 1000);
    const planIdB = await createFlatPlanAs(tokenB, 'B Plan', 1000);
    const subscriptionIdA = await createSubscriptionAs(tokenA, customerIdA, planIdA);
    const subscriptionIdB = await createSubscriptionAs(tokenB, customerIdB, planIdB);
    await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ subscriptionId: subscriptionIdA });
    await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ subscriptionId: subscriptionIdB });

    const res = await request(app).get('/invoices').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
  });

  it('filters by status', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);
    const planA = await createFlatPlanAs(token, 'Plan A', 1000);
    const planB = await createFlatPlanAs(token, 'Plan B', 2000);
    const subA = await createSubscriptionAs(token, customerId, planA);
    const subB = await createSubscriptionAs(token, customerId, planB);
    const invoiceA = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscriptionId: subA });
    await request(app).post('/invoices').set('Authorization', `Bearer ${token}`).send({ subscriptionId: subB });
    await request(app)
      .post(`/invoices/${invoiceA.body.invoice.id}/finalize`)
      .set('Authorization', `Bearer ${token}`);

    const res = await request(app).get('/invoices?status=OPEN').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].id).toBe(invoiceA.body.invoice.id);
  });
});

describe('GET /invoices/:id', () => {
  it('returns 404 for an invoice belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const customerIdB = await createCustomerAs(tokenB, 'b-cust@example.com');
    const planIdB = await createFlatPlanAs(tokenB, 'Pro Monthly', 2900);
    const subscriptionIdB = await createSubscriptionAs(tokenB, customerIdB, planIdB);
    const created = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ subscriptionId: subscriptionIdB });

    const res = await request(app)
      .get(`/invoices/${created.body.invoice.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});

describe('invoice status transitions', () => {
  async function createDraftInvoice(token: string) {
    const customerId = await createCustomerAs(token);
    const planId = await createFlatPlanAs(token, 'Pro Monthly', 2900);
    const subscriptionId = await createSubscriptionAs(token, customerId, planId);
    const res = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ subscriptionId });
    return res.body.invoice.id as string;
  }

  it('finalizes a DRAFT invoice to OPEN', async () => {
    const token = await signupAndGetToken();
    const invoiceId = await createDraftInvoice(token);

    const res = await request(app).post(`/invoices/${invoiceId}/finalize`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('OPEN');
  });

  it('marks an OPEN invoice as PAID', async () => {
    const token = await signupAndGetToken();
    const invoiceId = await createDraftInvoice(token);
    await request(app).post(`/invoices/${invoiceId}/finalize`).set('Authorization', `Bearer ${token}`);

    const res = await request(app).post(`/invoices/${invoiceId}/pay`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('PAID');
  });

  it('voids a DRAFT invoice', async () => {
    const token = await signupAndGetToken();
    const invoiceId = await createDraftInvoice(token);

    const res = await request(app).post(`/invoices/${invoiceId}/void`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('VOID');
  });

  it('rejects paying a DRAFT invoice directly with a 409', async () => {
    const token = await signupAndGetToken();
    const invoiceId = await createDraftInvoice(token);

    const res = await request(app).post(`/invoices/${invoiceId}/pay`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
  });

  it('rejects voiding an already-PAID invoice with a 409', async () => {
    const token = await signupAndGetToken();
    const invoiceId = await createDraftInvoice(token);
    await request(app).post(`/invoices/${invoiceId}/finalize`).set('Authorization', `Bearer ${token}`);
    await request(app).post(`/invoices/${invoiceId}/pay`).set('Authorization', `Bearer ${token}`);

    const res = await request(app).post(`/invoices/${invoiceId}/void`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
  });
});
