import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ApiError, errorHandler, notFoundHandler } from './errorHandler';

function appThatThrows(err: unknown) {
  const app = express();
  app.get('/boom', (_req, _res) => {
    throw err;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('maps a ZodError to a 400 VALIDATION_ERROR with flattened details', async () => {
    const schema = z.object({ email: z.string().email() });
    let zodError: unknown;
    try {
      schema.parse({ email: 'not-an-email' });
    } catch (err) {
      zodError = err;
    }

    const res = await request(appThatThrows(zodError)).get('/boom');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fieldErrors.email).toBeDefined();
  });

  it('maps an ApiError to its own status, code, and details', async () => {
    const res = await request(appThatThrows(ApiError.conflict('already exists', { id: 1 }))).get(
      '/boom',
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'CONFLICT',
      message: 'already exists',
      details: { id: 1 },
    });
  });

  it('defaults ApiError.unauthorized and ApiError.forbidden messages', async () => {
    const unauthorized = await request(appThatThrows(ApiError.unauthorized())).get('/boom');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error.message).toBe('Unauthorized');

    const forbidden = await request(appThatThrows(ApiError.forbidden())).get('/boom');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.message).toBe('Forbidden');
  });

  it('hides the real error behind a generic INTERNAL_ERROR for an unexpected throw', async () => {
    const res = await request(appThatThrows(new Error('db connection string leaked'))).get(
      '/boom',
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
    expect(JSON.stringify(res.body)).not.toContain('leaked');
  });

  it('routes an unmatched path through notFoundHandler into a 404 NOT_FOUND', async () => {
    const app = express();
    app.use(notFoundHandler);
    app.use(errorHandler);

    const res = await request(app).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('No route for GET /nope');
  });
});
