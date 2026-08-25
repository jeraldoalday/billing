import type { NextFunction, Request, Response } from 'express';

/**
 * Cross-origin access control for the browser client in `web/`.
 *
 * The API is token-based (the access token travels in an `Authorization`
 * header, never in a cookie), so this deliberately does *not* send
 * `Access-Control-Allow-Credentials`. Nothing the browser sends
 * automatically — cookies, HTTP auth — can reach the API from another
 * origin, which keeps the whole class of CSRF attacks off the table even
 * when an origin is allowed.
 *
 * Written by hand rather than pulled in as a dependency: the policy is a
 * fixed allowlist plus a preflight reply, which is less code than the
 * configuration surface of a package would be.
 */

export interface CorsOptions {
  /** Exact origins allowed to call the API, e.g. `http://localhost:5173`. */
  allowedOrigins: readonly string[];
  /** Methods advertised on a preflight response. */
  allowedMethods?: readonly string[];
  /** Request headers the browser may send cross-origin. */
  allowedHeaders?: readonly string[];
  /** How long a browser may cache a preflight result, in seconds. */
  maxAgeSeconds?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] as const;
const DEFAULT_HEADERS = ['Authorization', 'Content-Type'] as const;

/**
 * Parses the `CORS_ORIGINS` environment value: a comma-separated list of
 * origins. Blank entries are dropped and a trailing slash is trimmed so
 * that `http://localhost:5173/` and `http://localhost:5173` — which the
 * browser sends as the latter — are configured identically.
 */
export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
}

export function createCorsMiddleware(options: CorsOptions) {
  const allowed = new Set(options.allowedOrigins);
  const allowAny = allowed.has('*');
  const methods = (options.allowedMethods ?? DEFAULT_METHODS).join(', ');
  const headers = (options.allowedHeaders ?? DEFAULT_HEADERS).join(', ');
  const maxAge = String(options.maxAgeSeconds ?? 600);

  return function cors(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;

    // Same-origin requests and non-browser callers (curl, the test suite,
    // another service) send no Origin at all. They are not subject to the
    // policy, so they pass straight through unannotated.
    if (typeof origin !== 'string') {
      next();
      return;
    }

    // The response varies by Origin whether or not this one is allowed, so
    // a shared cache must never serve one origin's response to another.
    res.setHeader('Vary', 'Origin');

    if (!allowAny && !allowed.has(origin)) {
      // A disallowed origin gets no CORS headers, which is what makes the
      // browser block it. The request itself is still handled normally so
      // that server-to-server callers sending a stray Origin aren't broken.
      next();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', allowAny ? '*' : origin);

    if (req.method === 'OPTIONS') {
      // Answer the preflight here. Falling through would reach
      // notFoundHandler, since no route registers an OPTIONS handler.
      res.setHeader('Access-Control-Allow-Methods', methods);
      res.setHeader('Access-Control-Allow-Headers', headers);
      res.setHeader('Access-Control-Max-Age', maxAge);
      res.status(204).end();
      return;
    }

    next();
  };
}
