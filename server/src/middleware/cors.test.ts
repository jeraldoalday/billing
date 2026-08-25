import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCorsMiddleware, parseAllowedOrigins } from './cors';
import { errorHandler, notFoundHandler } from './errorHandler';

const WEB_ORIGIN = 'http://localhost:5173';

function appWith(origins: string[]) {
  const app = express();
  app.use(createCorsMiddleware({ allowedOrigins: origins }));
  app.get('/thing', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/thing', (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('parseAllowedOrigins', () => {
  it('splits a comma-separated list', () => {
    expect(parseAllowedOrigins('http://a.test,http://b.test')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('trims surrounding whitespace around each entry', () => {
    expect(parseAllowedOrigins(' http://a.test ,  http://b.test')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('drops a trailing slash so it matches the Origin a browser sends', () => {
    expect(parseAllowedOrigins('http://a.test/')).toEqual(['http://a.test']);
  });

  it('ignores blank entries from a trailing or doubled comma', () => {
    expect(parseAllowedOrigins('http://a.test,,')).toEqual(['http://a.test']);
  });

  it('returns nothing for an empty setting', () => {
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
  });
});

describe('createCorsMiddleware', () => {
  it('echoes an allowed origin back on a simple request', async () => {
    const res = await request(appWith([WEB_ORIGIN]))
      .get('/thing')
      .set('Origin', WEB_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['vary']).toContain('Origin');
  });

  it('answers a preflight with 204 and the allowed methods and headers', async () => {
    const res = await request(appWith([WEB_ORIGIN]))
      .options('/thing')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  // Without this the preflight would fall through to notFoundHandler, since
  // no route registers an OPTIONS handler, and the browser would report a
  // CORS failure rather than the 404 it really got.
  it('does not let a preflight reach the not-found handler', async () => {
    const res = await request(appWith([WEB_ORIGIN]))
      .options('/no-such-route')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).toBe(204);
  });

  it('omits the CORS headers for an origin that is not allowed', async () => {
    const res = await request(appWith([WEB_ORIGIN]))
      .get('/thing')
      .set('Origin', 'http://evil.test');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Still varies by Origin, so a cache can't hand this uncredentialed
    // response to an origin that would have been allowed.
    expect(res.headers['vary']).toContain('Origin');
  });

  it('matches origins exactly rather than by prefix', async () => {
    const res = await request(appWith(['http://localhost:5173']))
      .get('/thing')
      .set('Origin', 'http://localhost:5173.evil.test');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows any of several configured origins', async () => {
    const app = appWith(['http://a.test', 'http://b.test']);

    const a = await request(app).get('/thing').set('Origin', 'http://a.test');
    const b = await request(app).get('/thing').set('Origin', 'http://b.test');

    expect(a.headers['access-control-allow-origin']).toBe('http://a.test');
    expect(b.headers['access-control-allow-origin']).toBe('http://b.test');
  });

  it('leaves requests without an Origin header untouched', async () => {
    const res = await request(appWith([WEB_ORIGIN])).get('/thing');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['vary']).toBeUndefined();
  });

  it('answers with a wildcard when "*" is configured', async () => {
    const res = await request(appWith(['*']))
      .get('/thing')
      .set('Origin', 'http://anywhere.test');

    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  // Credentialed requests are meaningless against a wildcard origin, and
  // this API never wants them: the token is sent explicitly by the client.
  it('never allows credentials', async () => {
    const res = await request(appWith([WEB_ORIGIN]))
      .get('/thing')
      .set('Origin', WEB_ORIGIN);

    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('honours custom methods, headers, and max-age', async () => {
    const app = express();
    app.use(
      createCorsMiddleware({
        allowedOrigins: [WEB_ORIGIN],
        allowedMethods: ['GET'],
        allowedHeaders: ['X-Api-Key'],
        maxAgeSeconds: 60,
      }),
    );
    app.get('/thing', (_req, res) => res.json({ ok: true }));

    const res = await request(app)
      .options('/thing')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-methods']).toBe('GET');
    expect(res.headers['access-control-allow-headers']).toBe('X-Api-Key');
    expect(res.headers['access-control-max-age']).toBe('60');
  });
});
