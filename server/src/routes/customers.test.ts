import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

async function resetDb() {
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

async function signupAndGetToken(email = 'user@acme.test') {
  const res = await request(app)
    .post('/auth/signup')
    .send({ organizationName: 'Acme Corp', email, password: 'super-secret-1' });
  return res.body.token as string;
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('POST /customers', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).post('/customers').send({});

    expect(res.status).toBe(401);
  });

  it('creates a customer', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Doe', email: 'jane@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.customer.name).toBe('Jane Doe');
    expect(res.body.customer.email).toBe('jane@example.com');
  });

  it('rejects an invalid email with 400', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Doe', email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 for a duplicate email within the same organization', async () => {
    const token = await signupAndGetToken();
    await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Doe', email: 'jane@example.com' });

    const res = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Impostor', email: 'jane@example.com' });

    expect(res.status).toBe(409);
  });
});

describe('GET /customers', () => {
  it('only lists customers belonging to the caller organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'A Customer', email: 'a-cust@example.com' });
    await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B Customer', email: 'b-cust@example.com' });

    const res = await request(app).get('/customers').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.customers[0].name).toBe('A Customer');
  });
});

describe('GET /customers/:id', () => {
  it('returns 404 for a customer belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const created = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B Customer', email: 'b-cust@example.com' });

    const res = await request(app)
      .get(`/customers/${created.body.customer.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});

describe('PATCH /customers/:id', () => {
  it('updates a customer owned by the caller', async () => {
    const token = await signupAndGetToken();
    const created = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Doe', email: 'jane@example.com' });

    const res = await request(app)
      .patch(`/customers/${created.body.customer.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Smith' });

    expect(res.status).toBe(200);
    expect(res.body.customer.name).toBe('Jane Smith');
  });
});

describe('DELETE /customers/:id', () => {
  it('deletes a customer owned by the caller', async () => {
    const token = await signupAndGetToken();
    const created = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Doe', email: 'jane@example.com' });

    const res = await request(app)
      .delete(`/customers/${created.body.customer.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    const getRes = await request(app)
      .get(`/customers/${created.body.customer.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(404);
  });

  it('returns 404 when deleting a customer belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const created = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B Customer', email: 'b-cust@example.com' });

    const res = await request(app)
      .delete(`/customers/${created.body.customer.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});
