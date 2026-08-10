import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requireAuth } from './auth';
import { ApiError } from './errorHandler';
import { signAccessToken } from '../lib/jwt';

function mockReq(authorization?: string): Request {
  return { headers: { authorization } } as unknown as Request;
}

function firstCallArg(next: ReturnType<typeof vi.fn>): ApiError {
  const [err] = next.mock.calls[0] as [ApiError];
  return err;
}

describe('requireAuth', () => {
  it('calls next with an ApiError when there is no Authorization header', () => {
    const next = vi.fn();

    requireAuth(mockReq(undefined), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = firstCallArg(next);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it('calls next with an ApiError when the header is not a Bearer token', () => {
    const next = vi.fn();

    requireAuth(mockReq('Basic sometoken'), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(firstCallArg(next)).toBeInstanceOf(ApiError);
  });

  it('calls next with an ApiError when the token is invalid', () => {
    const next = vi.fn();

    requireAuth(mockReq('Bearer not-a-real-token'), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = firstCallArg(next);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it('attaches req.auth and calls next with no error for a valid token', () => {
    const token = signAccessToken({ sub: 'user_1', orgId: 'org_1', email: 'a@example.com' });
    const req = mockReq(`Bearer ${token}`);
    const next = vi.fn();

    requireAuth(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toEqual({ sub: 'user_1', orgId: 'org_1', email: 'a@example.com' });
  });
});
