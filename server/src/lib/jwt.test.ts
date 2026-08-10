import { describe, expect, it } from 'vitest';
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
});
