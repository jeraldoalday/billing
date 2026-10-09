import 'dotenv/config';
import { z } from 'zod';

// The fallback used when JWT_SECRET is unset. Fine for a fresh checkout
// running locally, but it is checked into this repo and therefore public —
// a production deployment that starts on it would be signing session
// tokens with a secret anyone can read, and forge, by reading this file.
export const INSECURE_DEFAULT_JWT_SECRET = 'dev-secret-change-me-in-production';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1).default('file:./dev.db'),
    JWT_SECRET: z.string().min(16).default(INSECURE_DEFAULT_JWT_SECRET),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    // Browser origins allowed to call the API, comma-separated (see
    // src/middleware/cors.ts). Defaults to the Vite dev server in web/ so a
    // fresh checkout works with no configuration; a deployment sets this to
    // the real web origin. "*" allows any origin, which is only ever
    // appropriate for a public, token-authenticated API.
    CORS_ORIGINS: z.string().default('http://localhost:5173'),

    // Background worker (src/worker.ts). The defaults suit a single-process
    // deployment: sweeps often enough that a renewal or a retry is never more
    // than a few minutes late, rarely enough that an idle installation isn't
    // querying in a tight loop. Every one is a millisecond count so it can be
    // turned right down in development without a unit suffix to parse.
    WORKER_TICK_MS: z.coerce.number().int().positive().default(1_000),
    WORKER_BILLING_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    WORKER_DUNNING_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    WORKER_WEBHOOK_RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 1000),
    // How many job handlers may run at once in one worker process. Each one
    // holds a database connection and may talk to the payment gateway, so
    // this is deliberately small.
    WORKER_CONCURRENCY: z.coerce.number().int().positive().max(64).default(4),
  })
  // JWT_SECRET falling back to INSECURE_DEFAULT_JWT_SECRET is fine for a
  // fresh checkout, which is why the field itself stays optional-with-a-
  // default above. In production specifically, that same fallback is a
  // real vulnerability — every token this process would ever issue could
  // be forged by anyone who has read this file — so a production process
  // refuses to start on it rather than quietly serving requests with it.
  .refine((data) => data.NODE_ENV !== 'production' || data.JWT_SECRET !== INSECURE_DEFAULT_JWT_SECRET, {
    message: 'JWT_SECRET must be set to a real secret when NODE_ENV=production',
    path: ['JWT_SECRET'],
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Failed to load environment configuration');
  }
  return parsed.data;
}

export const env = parseEnv();
