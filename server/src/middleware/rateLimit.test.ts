import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createAuthRateLimiter } from './rateLimit';

function appWithLimiter(limiter: ReturnType<typeof createAuthRateLimiter>) {
  const app = express();
  app.get('/probe', limiter, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('createAuthRateLimiter', () => {
  it('allows requests up to the limit and blocks the next one with 429', async () => {
    const app = appWithLimiter(createAuthRateLimiter({ limit: 3, windowMs: 60_000 }));

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/probe');
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).get('/probe');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('does not count successful requests when skipSuccessfulRequests is set', async () => {
    const app = appWithLimiter(
      createAuthRateLimiter({ limit: 2, windowMs: 60_000, skipSuccessfulRequests: true }),
    );

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).get('/probe');
      expect(res.status).toBe(200);
    }
  });
});
