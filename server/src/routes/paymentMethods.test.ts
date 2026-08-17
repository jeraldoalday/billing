import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

async function resetDb() {
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

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('POST /payment-methods', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).post('/payment-methods').send({});

    expect(res.status).toBe(401);
  });

  it('adds a payment method, storing only brand/last4/expiry', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);

    const res = await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, cardNumber: '4242424242424242', expMonth: 12, expYear: 2030 });

    expect(res.status).toBe(201);
    expect(res.body.paymentMethod.brand).toBe('VISA');
    expect(res.body.paymentMethod.last4).toBe('4242');
    expect(res.body.paymentMethod).not.toHaveProperty('cardNumber');
  });

  it('rejects a cardNumber that is not 13-19 digits', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);

    const res = await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, cardNumber: '123', expMonth: 12, expYear: 2030 });

    expect(res.status).toBe(400);
  });

  it('rejects an expired card', async () => {
    const token = await signupAndGetToken();
    const customerId = await createCustomerAs(token);

    const res = await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, cardNumber: '4242424242424242', expMonth: 1, expYear: 2020 });

    expect(res.status).toBe(400);
  });

  it('returns 404 when the customer belongs to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const customerIdB = await createCustomerAs(tokenB, 'b-cust@example.com');

    const res = await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerId: customerIdB, cardNumber: '4242424242424242', expMonth: 12, expYear: 2030 });

    expect(res.status).toBe(404);
  });
});

describe('GET /payment-methods', () => {
  it('only lists payment methods belonging to the caller organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const customerIdA = await createCustomerAs(tokenA, 'a-cust@example.com');
    const customerIdB = await createCustomerAs(tokenB, 'b-cust@example.com');
    await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerId: customerIdA, cardNumber: '4242424242424242', expMonth: 12, expYear: 2030 });
    await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ customerId: customerIdB, cardNumber: '4242424242424242', expMonth: 12, expYear: 2030 });

    const res = await request(app).get('/payment-methods').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.paymentMethods).toHaveLength(1);
  });

  it('filters by customerId', async () => {
    const token = await signupAndGetToken();
    const customerA = await createCustomerAs(token, 'a@example.com');
    const customerB = await createCustomerAs(token, 'b@example.com');
    await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId: customerA, cardNumber: '4242424242424242', expMonth: 12, expYear: 2030 });
    await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId: customerB, cardNumber: '4242424242424242', expMonth: 12, expYear: 2030 });

    const res = await request(app)
      .get(`/payment-methods?customerId=${customerA}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.paymentMethods).toHaveLength(1);
  });
});

describe('GET /payment-methods/:id', () => {
  it('returns 404 for a payment method belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const customerIdB = await createCustomerAs(tokenB, 'b-cust@example.com');
    const created = await request(app)
      .post('/payment-methods')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ customerId: customerIdB, cardNumber: '4242424242424242', expMonth: 12, expYear: 2030 });

    const res = await request(app)
      .get(`/payment-methods/${created.body.paymentMethod.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});
