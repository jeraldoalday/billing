import rateLimit, { type Options } from 'express-rate-limit';

export function createAuthRateLimiter(overrides: Partial<Options> = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' } },
    ...overrides,
  });
}

// Signup volume itself is the abuse signal (account/org spam), so every
// request counts against the limit regardless of outcome.
export const signupRateLimiter = createAuthRateLimiter({ limit: 30 });

// Login abuse looks like a burst of *failed* attempts (credential stuffing /
// brute force). Successful logins don't count, so legitimate users who log
// in frequently are never penalized by this limiter.
export const loginRateLimiter = createAuthRateLimiter({ limit: 10, skipSuccessfulRequests: true });

// Changing a password (PATCH /auth/me) requires currentPassword, which is
// exactly the kind of guessable secret a login attempt is — so a stolen or
// leaked access token shouldn't be enough to brute-force it for free just
// because the bearer check already passed. Successful requests (a plain
// name change, or a correct password change) don't count, so a legitimate
// user editing their profile repeatedly is never penalized.
export const profileUpdateRateLimiter = createAuthRateLimiter({ limit: 10, skipSuccessfulRequests: true });
