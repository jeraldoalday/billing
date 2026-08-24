// The background-job policy: what states a job run can be in, how a failed
// run backs off before it is tried again, and when it has run out of
// attempts. Kept pure so the policy is testable without a queue, a clock or
// a database — the in-process queue that applies these decisions lives in
// src/lib/jobQueue.ts, and the rows they are persisted to are written by
// src/services/job.service.ts.

// SQLite has no native enum type (see prisma/schema.prisma), so JobRun's
// `status` column is a plain string. This tuple is the single source of
// truth for the valid values, consumed by Zod schemas (z.enum) and anywhere
// else that needs the allowed set at runtime.
//
// PENDING covers both "never started" and "failed but still has attempts
// left", exactly as WebhookDelivery's PENDING does (src/domain/webhook.ts):
// the difference is visible in attemptsMade/runAt, and collapsing them keeps
// "what work is due" a single-status query.
export const JOB_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// The recurring jobs this platform runs. Namespaced `resource.action` like
// the webhook catalogue, so the name reads the same way in a log line, a
// JobRun row and a POST /jobs body.
export const JOB_NAMES = ['billing.cycle', 'dunning.sweep', 'webhook.retry'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

// Total attempts (including the first) before a job run is marked FAILED
// and left alone. Three is deliberately modest: every job this platform
// runs is a sweep that will be enqueued again on the next tick anyway, so
// an outage is recovered by the schedule rather than by exhausting a long
// retry budget against a database that is still down.
export const DEFAULT_MAX_JOB_ATTEMPTS = 3;

const JOB_BASE_DELAY_MS = 5_000;
const JOB_BACKOFF_FACTOR = 4;
// Caps the exponential so a job that keeps failing stays inside the window
// its own schedule repeats in, rather than drifting past it.
const JOB_MAX_DELAY_MS = 10 * 60 * 1000;

export interface JobBackoffOptions {
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

// A run that has never been attempted is due immediately; every later
// attempt waits base * factor^(n-1), clamped. No jitter: two jobs of the
// same name never run concurrently in this queue (they are separate rows
// with separate schedules), so there is no thundering herd to spread out,
// and a deterministic delay is one a test can assert exactly.
export function jobBackoffDelayMs(attemptsMade: number, options: JobBackoffOptions = {}): number {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 0) {
    throw new Error('attemptsMade must be a non-negative integer');
  }

  const {
    baseDelayMs = JOB_BASE_DELAY_MS,
    factor = JOB_BACKOFF_FACTOR,
    maxDelayMs = JOB_MAX_DELAY_MS,
  } = options;

  if (attemptsMade === 0) {
    return 0;
  }

  return Math.min(maxDelayMs, baseDelayMs * factor ** (attemptsMade - 1));
}

// When a run that has just made its `attemptsMade`-th attempt should be
// tried again, or null when the budget is spent (the caller should then
// move the run to FAILED). `attemptsMade` is a count, not an index.
export function nextJobAttemptAt(
  attemptsMade: number,
  now: Date,
  options: JobBackoffOptions = {},
): Date | null {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS;
  if (attemptsMade >= maxAttempts) {
    return null;
  }

  return new Date(now.getTime() + jobBackoffDelayMs(attemptsMade, options));
}

export function isJobExhausted(attemptsMade: number, maxAttempts = DEFAULT_MAX_JOB_ATTEMPTS): boolean {
  return attemptsMade >= maxAttempts;
}

// How many attempts are left in the budget, floored at 0 so a run that
// somehow over-attempted (only reachable if the budget shrinks between
// deploys) reports "none left" rather than a negative number.
export function remainingJobAttempts(
  attemptsMade: number,
  maxAttempts = DEFAULT_MAX_JOB_ATTEMPTS,
): number {
  return Math.max(0, maxAttempts - attemptsMade);
}

// A run only moves forward: PENDING picks up work, RUNNING settles it, and
// a settled run is history. A retry is *not* modelled as FAILED -> PENDING —
// a run that failed with attempts left goes RUNNING -> PENDING, so FAILED
// means "gave up" and nothing else, which is what makes a FAILED row worth
// alerting on.
const ALLOWED_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  PENDING: ['RUNNING'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'PENDING'],
  SUCCEEDED: [],
  FAILED: [],
};

export function canTransitionJobStatus(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export interface JobRunState {
  attemptsMade: number;
  maxAttempts: number;
}

export interface JobOutcomeDecision {
  /** The status the run should be persisted with. */
  status: JobStatus;
  /** When the next attempt becomes due, or null if the run is settled. */
  runAt: Date | null;
  /** Attempts made once this outcome is applied. */
  attemptsMade: number;
}

// Applies an attempt's outcome to a run, returning the state it should be
// persisted with. Splitting this out from the queue keeps "succeeded, or
// retry, or give up" in one pure place that a test can walk end to end.
export function applyJobOutcome(
  run: JobRunState,
  outcome: 'SUCCEEDED' | 'FAILED',
  now: Date,
  options: JobBackoffOptions = {},
): JobOutcomeDecision {
  const attemptsMade = run.attemptsMade + 1;

  if (outcome === 'SUCCEEDED') {
    return { status: 'SUCCEEDED', runAt: null, attemptsMade };
  }

  const runAt = nextJobAttemptAt(attemptsMade, now, { ...options, maxAttempts: run.maxAttempts });
  if (!runAt) {
    return { status: 'FAILED', runAt: null, attemptsMade };
  }

  return { status: 'PENDING', runAt, attemptsMade };
}

// Whether a PENDING run is due to be picked up at `now`. A run whose time
// has come exactly is due (the boundary is inclusive), matching how every
// other "is it time yet" check in this codebase treats `lte`.
export function isJobDue(run: { status: JobStatus; runAt: Date }, now: Date): boolean {
  return run.status === 'PENDING' && run.runAt.getTime() <= now.getTime();
}

// The failure text stored on a run. Errors reach the queue as `unknown`
// (a handler may throw anything), and the column is a bounded string, so
// normalising here keeps every caller from repeating the same dance.
export const MAX_JOB_ERROR_LENGTH = 500;

export function describeJobError(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  return (message || 'Unknown error').slice(0, MAX_JOB_ERROR_LENGTH);
}
