import { describe, expect, it } from 'vitest';
import {
  applyJobOutcome,
  canTransitionJobStatus,
  DEFAULT_MAX_JOB_ATTEMPTS,
  describeJobError,
  isJobDue,
  isJobExhausted,
  isJobName,
  isTerminalJobStatus,
  jobBackoffDelayMs,
  JOB_NAMES,
  JOB_STATUSES,
  MAX_JOB_ERROR_LENGTH,
  nextJobAttemptAt,
  remainingJobAttempts,
} from './job';

const NOW = new Date('2026-09-01T12:00:00.000Z');

describe('job names and statuses', () => {
  it('exposes the recurring jobs the worker runs', () => {
    expect(JOB_NAMES).toEqual(['billing.cycle', 'dunning.sweep', 'webhook.retry']);
  });

  it('recognises known job names and rejects unknown ones', () => {
    expect(isJobName('billing.cycle')).toBe(true);
    expect(isJobName('dunning.sweep')).toBe(true);
    expect(isJobName('invoice.email')).toBe(false);
    expect(isJobName('')).toBe(false);
  });

  it('lists exactly the four persisted statuses', () => {
    expect(JOB_STATUSES).toEqual(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']);
  });
});

describe('jobBackoffDelayMs', () => {
  it('is zero before any attempt has been made', () => {
    expect(jobBackoffDelayMs(0)).toBe(0);
  });

  it('grows exponentially with each failed attempt', () => {
    expect(jobBackoffDelayMs(1)).toBe(5_000);
    expect(jobBackoffDelayMs(2)).toBe(20_000);
    expect(jobBackoffDelayMs(3)).toBe(80_000);
  });

  it('clamps to the maximum delay rather than growing without bound', () => {
    expect(jobBackoffDelayMs(10)).toBe(10 * 60 * 1000);
    expect(jobBackoffDelayMs(50)).toBe(10 * 60 * 1000);
  });

  it('honours caller-supplied backoff parameters', () => {
    expect(jobBackoffDelayMs(2, { baseDelayMs: 100, factor: 3 })).toBe(300);
    expect(jobBackoffDelayMs(5, { baseDelayMs: 100, factor: 3, maxDelayMs: 500 })).toBe(500);
  });

  it('rejects a nonsensical attempt count', () => {
    expect(() => jobBackoffDelayMs(-1)).toThrow(/non-negative integer/);
    expect(() => jobBackoffDelayMs(1.5)).toThrow(/non-negative integer/);
  });
});

describe('nextJobAttemptAt', () => {
  it('schedules the next attempt one backoff delay out', () => {
    expect(nextJobAttemptAt(1, NOW)?.toISOString()).toBe('2026-09-01T12:00:05.000Z');
    expect(nextJobAttemptAt(2, NOW)?.toISOString()).toBe('2026-09-01T12:00:20.000Z');
  });

  it('returns null once the attempt budget is spent', () => {
    expect(nextJobAttemptAt(DEFAULT_MAX_JOB_ATTEMPTS, NOW)).toBeNull();
    expect(nextJobAttemptAt(DEFAULT_MAX_JOB_ATTEMPTS + 5, NOW)).toBeNull();
  });

  it('respects a per-job attempt budget', () => {
    expect(nextJobAttemptAt(1, NOW, { maxAttempts: 1 })).toBeNull();
    expect(nextJobAttemptAt(1, NOW, { maxAttempts: 9, baseDelayMs: 1_000 })?.toISOString()).toBe(
      '2026-09-01T12:00:01.000Z',
    );
  });
});

describe('attempt budget helpers', () => {
  it('reports exhaustion at the budget, not past it', () => {
    expect(isJobExhausted(DEFAULT_MAX_JOB_ATTEMPTS - 1)).toBe(false);
    expect(isJobExhausted(DEFAULT_MAX_JOB_ATTEMPTS)).toBe(true);
  });

  it('counts remaining attempts and never goes negative', () => {
    expect(remainingJobAttempts(0)).toBe(DEFAULT_MAX_JOB_ATTEMPTS);
    expect(remainingJobAttempts(DEFAULT_MAX_JOB_ATTEMPTS)).toBe(0);
    expect(remainingJobAttempts(DEFAULT_MAX_JOB_ATTEMPTS + 7)).toBe(0);
  });
});

describe('job status transitions', () => {
  it('lets a pending run start and a running run settle', () => {
    expect(canTransitionJobStatus('PENDING', 'RUNNING')).toBe(true);
    expect(canTransitionJobStatus('RUNNING', 'SUCCEEDED')).toBe(true);
    expect(canTransitionJobStatus('RUNNING', 'FAILED')).toBe(true);
  });

  it('models a retry as running -> pending, never failed -> pending', () => {
    expect(canTransitionJobStatus('RUNNING', 'PENDING')).toBe(true);
    expect(canTransitionJobStatus('FAILED', 'PENDING')).toBe(false);
  });

  it('treats settled statuses as terminal', () => {
    expect(isTerminalJobStatus('SUCCEEDED')).toBe(true);
    expect(isTerminalJobStatus('FAILED')).toBe(true);
    expect(isTerminalJobStatus('PENDING')).toBe(false);
    expect(isTerminalJobStatus('RUNNING')).toBe(false);
  });
});

describe('applyJobOutcome', () => {
  const run = { attemptsMade: 0, maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS };

  it('settles a successful run and counts the attempt', () => {
    expect(applyJobOutcome(run, 'SUCCEEDED', NOW)).toEqual({
      status: 'SUCCEEDED',
      runAt: null,
      attemptsMade: 1,
    });
  });

  it('reschedules a failure that still has attempts left', () => {
    const decision = applyJobOutcome(run, 'FAILED', NOW);

    expect(decision.status).toBe('PENDING');
    expect(decision.attemptsMade).toBe(1);
    expect(decision.runAt?.toISOString()).toBe('2026-09-01T12:00:05.000Z');
  });

  it('gives up once the budget is spent', () => {
    const decision = applyJobOutcome({ attemptsMade: 2, maxAttempts: 3 }, 'FAILED', NOW);

    expect(decision).toEqual({ status: 'FAILED', runAt: null, attemptsMade: 3 });
  });

  it('gives up immediately for a run allowed only one attempt', () => {
    const decision = applyJobOutcome({ attemptsMade: 0, maxAttempts: 1 }, 'FAILED', NOW);

    expect(decision.status).toBe('FAILED');
    expect(decision.runAt).toBeNull();
  });

  it('walks a run through retry, retry, give up', () => {
    let state = { attemptsMade: 0, maxAttempts: 3 };
    const statuses: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      const decision = applyJobOutcome(state, 'FAILED', NOW);
      statuses.push(decision.status);
      state = { attemptsMade: decision.attemptsMade, maxAttempts: state.maxAttempts };
    }

    expect(statuses).toEqual(['PENDING', 'PENDING', 'FAILED']);
    expect(state.attemptsMade).toBe(3);
  });
});

describe('isJobDue', () => {
  it('is due the instant its scheduled time arrives', () => {
    expect(isJobDue({ status: 'PENDING', runAt: NOW }, NOW)).toBe(true);
  });

  it('is not due while its scheduled time is in the future', () => {
    const later = new Date(NOW.getTime() + 1);
    expect(isJobDue({ status: 'PENDING', runAt: later }, NOW)).toBe(false);
  });

  it('is never due unless it is pending', () => {
    expect(isJobDue({ status: 'RUNNING', runAt: NOW }, NOW)).toBe(false);
    expect(isJobDue({ status: 'SUCCEEDED', runAt: NOW }, NOW)).toBe(false);
    expect(isJobDue({ status: 'FAILED', runAt: NOW }, NOW)).toBe(false);
  });
});

describe('describeJobError', () => {
  it('uses an Error message', () => {
    expect(describeJobError(new Error('gateway timed out'))).toBe('gateway timed out');
  });

  it('passes a thrown string through', () => {
    expect(describeJobError('nope')).toBe('nope');
  });

  it('serialises anything else', () => {
    expect(describeJobError({ code: 'E_BAD' })).toBe('{"code":"E_BAD"}');
  });

  it('falls back to a generic message for an empty one', () => {
    expect(describeJobError(new Error(''))).toBe('Unknown error');
  });

  it('truncates a runaway message so the column can hold it', () => {
    const described = describeJobError(new Error('x'.repeat(2_000)));

    expect(described).toHaveLength(MAX_JOB_ERROR_LENGTH);
  });
});
