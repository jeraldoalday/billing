import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';

// Kept in its own file (separate from auth.test.ts) so its many requests
// against the real /auth/login route don't push other tests over the
// shared, module-level rate limiter's threshold. The two cases below share
// that same limiter bucket (keyed by client IP), so order matters: the
// "successful logins" case runs first because skipSuccessfulRequests nets
// it back to ~0 hits, then the "too many failures" case is free to exhaust
// the remaining budget deliberately.
describe('login rate limiting', () => {
  it('does not rate limit successful logins', async () => {
    const app = createApp();

    await request(app).post('/auth/signup').send({
      organizationName: 'Acme Corp',
      email: 'frequent-user@acme.test',
      password: 'super-secret-1',
    });

    for (let i = 0; i < 15; i += 1) {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'frequent-user@acme.test', password: 'super-secret-1' });
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 after too many failed login attempts from the same client', async () => {
    const app = createApp();

    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'nobody@acme.test', password: 'wrong' });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@acme.test', password: 'wrong' });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});
