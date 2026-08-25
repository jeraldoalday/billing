import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('security headers', () => {
  const app = createApp();

  it('sets helmet security headers on every response', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('does not leak the framework via X-Powered-By', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('cross-origin access', () => {
  const app = createApp();

  it('allows the configured web origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('answers the preflight the browser sends before a login', async () => {
    const res = await request(app)
      .options('/auth/login')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });
});
