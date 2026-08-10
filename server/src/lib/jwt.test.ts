import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { signAccessToken, verifyAccessToken } from './jwt';

describe('jwt', () => {
  const payload = { sub: 'user_1', orgId: 'org_1', email: 'a@example.com' };

  it('round-trips a signed token', () => {
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);

    expect(decoded).toEqual(payload);
  });

  it('throws on a tampered token', () => {
    const token = signAccessToken(payload);

    expect(() => verifyAccessToken(`${token}tampered`)).toThrow();
  });

  it('throws on a garbage token', () => {
    expect(() => verifyAccessToken('not-a-real-token')).toThrow();
  });

  it('throws on an expired token', () => {
    const expired = jwt.sign(payload, env.JWT_SECRET, { expiresIn: -10 });

    expect(() => verifyAccessToken(expired)).toThrow();
  });

  it('throws on a token signed with a different secret', () => {
    const wrongSecret = jwt.sign(payload, 'a-completely-different-secret-value', { expiresIn: '1h' });

    expect(() => verifyAccessToken(wrongSecret)).toThrow();
  });

  it('throws when a required claim is missing', () => {
    const incomplete = jwt.sign({ sub: 'user_1', email: 'a@example.com' }, env.JWT_SECRET, {
      expiresIn: '1h',
    });

    expect(() => verifyAccessToken(incomplete)).toThrow('Invalid token payload');
  });
});
