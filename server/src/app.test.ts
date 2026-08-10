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
