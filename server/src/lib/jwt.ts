import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  email: string;
}

const ACCESS_TOKEN_TTL = '24h';

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);

  if (typeof decoded === 'string') {
    throw new Error('Invalid token payload');
  }

  const { sub, orgId, email } = decoded as Record<string, unknown>;
  if (typeof sub !== 'string' || typeof orgId !== 'string' || typeof email !== 'string') {
    throw new Error('Invalid token payload');
  }

  return { sub, orgId, email };
}
