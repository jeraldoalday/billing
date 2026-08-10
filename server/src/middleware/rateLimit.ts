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
