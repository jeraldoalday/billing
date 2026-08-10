import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

async function resetDb() {
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('POST /auth/signup', () => {
  it('creates an account and returns a token', async () => {
    const res = await request(app).post('/auth/signup').send({
      organizationName: 'Acme Corp',
      email: 'founder@acme.test',
      password: 'super-secret-1',
    });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.organization.slug).toBe('acme-corp');
  });

  it('rejects an invalid payload with 400', async () => {
    const res = await request(app).post('/auth/signup').send({
      organizationName: 'A',
      email: 'not-an-email',
      password: 'short',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app).post('/auth/signup').send({
      organizationName: 'Acme Corp',
      email: 'dupe@acme.test',
      password: 'super-secret-1',
    });

    const res = await request(app).post('/auth/signup').send({
      organizationName: 'Other Corp',
      email: 'dupe@acme.test',
      password: 'super-secret-1',
    });

    expect(res.status).toBe(409);
  });
});

describe('POST /auth/login', () => {
  it('logs in with correct credentials', async () => {
    await request(app).post('/auth/signup').send({
      organizationName: 'Acme Corp',
      email: 'user@acme.test',
      password: 'super-secret-1',
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'user@acme.test', password: 'super-secret-1' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('rejects wrong credentials with 401', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@acme.test', password: 'whatever' });

    expect(res.status).toBe(401);
  });
});

describe('GET /auth/me', () => {
  it('rejects requests with no token', async () => {
    const res = await request(app).get('/auth/me');

    expect(res.status).toBe(401);
  });

  it('rejects requests with a garbage token', async () => {
    const res = await request(app).get('/auth/me').set('Authorization', 'Bearer garbage');

    expect(res.status).toBe(401);
  });

  it('returns the current user for a valid token', async () => {
    const signupRes = await request(app).post('/auth/signup').send({
      organizationName: 'Acme Corp',
      email: 'user@acme.test',
      password: 'super-secret-1',
    });

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${signupRes.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('user@acme.test');
    expect(res.body.organization.slug).toBe('acme-corp');
  });
});

describe('PATCH /auth/me', () => {
  async function signupAndGetToken() {
    const res = await request(app).post('/auth/signup').send({
      organizationName: 'Acme Corp',
      email: 'user@acme.test',
      password: 'super-secret-1',
    });
    return res.body.token as string;
  }

  it('rejects requests with no token', async () => {
    const res = await request(app).patch('/auth/me').send({ name: 'New Name' });

    expect(res.status).toBe(401);
  });

  it('updates the display name', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('New Name');
  });

  it('rejects a password change without the current password', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: 'brand-new-secret' });

    expect(res.status).toBe(400);
  });

  it('rejects a password change with the wrong current password', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'wrong', newPassword: 'brand-new-secret' });

    expect(res.status).toBe(401);
  });

  it('changes the password and allows logging in with the new one', async () => {
    const token = await signupAndGetToken();

    const patchRes = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'super-secret-1', newPassword: 'brand-new-secret' });
    expect(patchRes.status).toBe(200);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'user@acme.test', password: 'brand-new-secret' });
    expect(loginRes.status).toBe(200);
  });
});
