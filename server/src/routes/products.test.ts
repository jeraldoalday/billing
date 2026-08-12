import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

async function resetDb() {
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

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('POST /products', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).post('/products').send({ name: 'API Access' });

    expect(res.status).toBe(401);
  });

  it('creates a product', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'API Access', description: 'Access to the REST API' });

    expect(res.status).toBe(201);
    expect(res.body.product.name).toBe('API Access');
    expect(res.body.product.active).toBe(true);
  });

  it('rejects an empty name with 400', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /products', () => {
  it('only lists products belonging to the caller organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');

    await request(app).post('/products').set('Authorization', `Bearer ${tokenA}`).send({ name: 'A Product' });
    await request(app).post('/products').set('Authorization', `Bearer ${tokenB}`).send({ name: 'B Product' });

    const res = await request(app).get('/products').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].name).toBe('A Product');
  });

  it('filters by active query param', async () => {
    const token = await signupAndGetToken();
    await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Active Product' });
    await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Archived Product', active: false });

    const res = await request(app).get('/products?active=false').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.products.map((p: { name: string }) => p.name)).toEqual(['Archived Product']);
  });
});

describe('GET /products/:id', () => {
  it('returns 404 for a product belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');

    const created = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B Product' });

    const res = await request(app)
      .get(`/products/${created.body.product.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });

  it('returns the product for the owning organization', async () => {
    const token = await signupAndGetToken();
    const created = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'API Access' });

    const res = await request(app)
      .get(`/products/${created.body.product.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe(created.body.product.id);
  });
});

describe('PATCH /products/:id', () => {
  it('updates a product owned by the caller', async () => {
    const token = await signupAndGetToken();
    const created = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'API Access' });

    const res = await request(app)
      .patch(`/products/${created.body.product.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'API Access Pro' });

    expect(res.status).toBe(200);
    expect(res.body.product.name).toBe('API Access Pro');
  });

  it('rejects an empty patch body with 400', async () => {
    const token = await signupAndGetToken();
    const created = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'API Access' });

    const res = await request(app)
      .patch(`/products/${created.body.product.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 404 when patching a product belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const created = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B Product' });

    const res = await request(app)
      .patch(`/products/${created.body.product.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /products/:id', () => {
  it('deletes a product owned by the caller', async () => {
    const token = await signupAndGetToken();
    const created = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'API Access' });

    const res = await request(app)
      .delete(`/products/${created.body.product.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    const getRes = await request(app)
      .get(`/products/${created.body.product.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(404);
  });

  it('returns 404 when deleting a product belonging to another organization', async () => {
    const tokenA = await signupAndGetToken('a@acme.test');
    const tokenB = await signupAndGetToken('b@other.test');
    const created = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B Product' });

    const res = await request(app)
      .delete(`/products/${created.body.product.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});
