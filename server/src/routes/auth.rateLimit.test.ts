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

// Same reasoning and isolation as the login block above: PATCH /auth/me
// shares a module-level limiter bucket (keyed by client IP) across every
// test that hits it, so its budget-exhausting case lives here rather than
// alongside the other /auth/me tests.
describe('profile password-change rate limiting', () => {
  it(
    'does not rate limit successful profile updates',
    async () => {
      const app = createApp();

      const signupRes = await request(app).post('/auth/signup').send({
        organizationName: 'Acme Corp',
        email: 'frequent-profile-editor@acme.test',
        password: 'super-secret-1',
      });
      const token = signupRes.body.token as string;

      // One more than the limiter's threshold: each request both verifies
      // and re-hashes a password (bcrypt), so this runs well under the
      // default test timeout but still needs headroom above it.
      for (let i = 0; i < 12; i += 1) {
        const res = await request(app)
          .patch('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .send({ currentPassword: 'super-secret-1', newPassword: 'super-secret-1' });
        expect(res.status).toBe(200);
      }
    },
    20_000,
  );

  it(
    'returns 429 after too many wrong-current-password attempts from the same client',
    async () => {
      const app = createApp();

      const signupRes = await request(app).post('/auth/signup').send({
        organizationName: 'Acme Corp',
        email: 'profile-attack-target@acme.test',
        password: 'super-secret-1',
      });
      const token = signupRes.body.token as string;

      for (let i = 0; i < 10; i += 1) {
        const res = await request(app)
          .patch('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .send({ currentPassword: 'wrong-guess', newPassword: 'brand-new-secret' });
        expect(res.status).toBe(401);
      }

      const blocked = await request(app)
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'wrong-guess', newPassword: 'brand-new-secret' });

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    },
    20_000,
  );
});
