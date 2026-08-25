import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1).default('file:./dev.db'),
  JWT_SECRET: z.string().min(16).default('dev-secret-change-me-in-production'),
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
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Failed to load environment configuration');
  }
  return parsed.data;
}

export const env = loadEnv();
