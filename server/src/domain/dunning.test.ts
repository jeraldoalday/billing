import { describe, expect, it } from 'vitest';
import {
  applyDunningAttemptOutcome,
  canTransitionDunningStatus,
  decideNextDunningStep,
  dunningAttemptSchedule,
  DUNNING_RETRY_OFFSET_DAYS,
  isDunningExhausted,
  isTerminalDunningStatus,
  MAX_DUNNING_ATTEMPTS,
  nextDunningAttemptAt,
  remainingDunningAttempts,
} from './dunning';

const START = new Date('2026-03-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAfterStart(days: number): Date {
  return new Date(START.getTime() + days * DAY_MS);
}

describe('dunningAttemptSchedule', () => {
  it('schedules one retry per configured offset', () => {
    const schedule = dunningAttemptSchedule(START);

    expect(schedule).toHaveLength(DUNNING_RETRY_OFFSET_DAYS.length);
    expect(schedule.map((date) => date.toISOString())).toEqual([
      '2026-03-02T12:00:00.000Z',
      '2026-03-04T12:00:00.000Z',
      '2026-03-08T12:00:00.000Z',
    ]);
  });

  it('preserves the time of day across the whole schedule', () => {
    const schedule = dunningAttemptSchedule(new Date('2026-03-01T23:59:59.000Z'));

    for (const date of schedule) {
      expect(date.getUTCHours()).toBe(23);
      expect(date.getUTCMinutes()).toBe(59);
    }
  });

  it('does not mutate the date it is given', () => {
    const startedAt = new Date(START);
    dunningAttemptSchedule(startedAt);

    expect(startedAt.toISOString()).toBe(START.toISOString());
  });
});

describe('nextDunningAttemptAt', () => {
  it('returns the first offset when no attempt has been made', () => {
    expect(nextDunningAttemptAt(START, 0)?.toISOString()).toBe('2026-03-02T12:00:00.000Z');
  });

  it('walks forward through the schedule as attempts are made', () => {
    expect(nextDunningAttemptAt(START, 1)?.toISOString()).toBe('2026-03-04T12:00:00.000Z');
    expect(nextDunningAttemptAt(START, 2)?.toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });

  it('returns null once the attempt budget is spent', () => {
    expect(nextDunningAttemptAt(START, MAX_DUNNING_ATTEMPTS)).toBeNull();
    expect(nextDunningAttemptAt(START, MAX_DUNNING_ATTEMPTS + 5)).toBeNull();
  });

  it('rejects a negative or fractional attempt count', () => {
    expect(() => nextDunningAttemptAt(START, -1)).toThrow(/non-negative integer/);
    expect(() => nextDunningAttemptAt(START, 1.5)).toThrow(/non-negative integer/);
  });
});

describe('isDunningExhausted / remainingDunningAttempts', () => {
  it('is not exhausted while retries remain', () => {
    expect(isDunningExhausted(0)).toBe(false);
    expect(isDunningExhausted(MAX_DUNNING_ATTEMPTS - 1)).toBe(false);
  });

  it('is exhausted at and beyond the budget', () => {
    expect(isDunningExhausted(MAX_DUNNING_ATTEMPTS)).toBe(true);
    expect(isDunningExhausted(MAX_DUNNING_ATTEMPTS + 1)).toBe(true);
  });

  it('never reports a negative number of remaining attempts', () => {
    expect(remainingDunningAttempts(0)).toBe(MAX_DUNNING_ATTEMPTS);
    expect(remainingDunningAttempts(MAX_DUNNING_ATTEMPTS + 4)).toBe(0);
  });
});

describe('canTransitionDunningStatus', () => {
  it('allows a scheduled campaign to reach any resolution', () => {
    expect(canTransitionDunningStatus('SCHEDULED', 'RECOVERED')).toBe(true);
    expect(canTransitionDunningStatus('SCHEDULED', 'EXHAUSTED')).toBe(true);
    expect(canTransitionDunningStatus('SCHEDULED', 'CANCELED')).toBe(true);
  });

  it('treats resolutions as terminal', () => {
    expect(canTransitionDunningStatus('RECOVERED', 'SCHEDULED')).toBe(false);
    expect(canTransitionDunningStatus('EXHAUSTED', 'RECOVERED')).toBe(false);
    expect(canTransitionDunningStatus('CANCELED', 'SCHEDULED')).toBe(false);
    expect(isTerminalDunningStatus('RECOVERED')).toBe(true);
    expect(isTerminalDunningStatus('SCHEDULED')).toBe(false);
  });

  it('does not allow a campaign to transition to itself', () => {
    expect(canTransitionDunningStatus('SCHEDULED', 'SCHEDULED')).toBe(false);
  });
});

describe('decideNextDunningStep', () => {
  it('waits while the next retry is still in the future', () => {
    const decision = decideNextDunningStep(
      { startedAt: START, attemptsMade: 0, nextAttemptAt: daysAfterStart(1) },
      daysAfterStart(0.5),
    );

    expect(decision.shouldAttempt).toBe(false);
    expect(decision.status).toBe('SCHEDULED');
    expect(decision.nextAttemptAt?.toISOString()).toBe(daysAfterStart(1).toISOString());
  });

  it('attempts once the scheduled instant has arrived', () => {
    const decision = decideNextDunningStep(
      { startedAt: START, attemptsMade: 0, nextAttemptAt: daysAfterStart(1) },
      daysAfterStart(1),
    );

    expect(decision.shouldAttempt).toBe(true);
    expect(decision.status).toBe('SCHEDULED');
  });

  it('derives the due instant when the campaign has none stored', () => {
    const decision = decideNextDunningStep(
      { startedAt: START, attemptsMade: 1, nextAttemptAt: null },
      daysAfterStart(5),
    );

    expect(decision.shouldAttempt).toBe(true);
    expect(decision.nextAttemptAt?.toISOString()).toBe(daysAfterStart(3).toISOString());
  });

  it('reports an exhausted budget instead of attempting again', () => {
    const decision = decideNextDunningStep(
      { startedAt: START, attemptsMade: MAX_DUNNING_ATTEMPTS, nextAttemptAt: null },
      daysAfterStart(30),
    );

    expect(decision.shouldAttempt).toBe(false);
    expect(decision.status).toBe('EXHAUSTED');
    expect(decision.nextAttemptAt).toBeNull();
  });
});

describe('applyDunningAttemptOutcome', () => {
  it('recovers the campaign on a successful retry', () => {
    const decision = applyDunningAttemptOutcome({ startedAt: START, attemptsMade: 0 }, 'SUCCEEDED');

    expect(decision.status).toBe('RECOVERED');
    expect(decision.nextAttemptAt).toBeNull();
  });

  it('schedules the following retry after a failure', () => {
    const decision = applyDunningAttemptOutcome({ startedAt: START, attemptsMade: 0 }, 'FAILED');

    expect(decision.status).toBe('SCHEDULED');
    expect(decision.nextAttemptAt?.toISOString()).toBe(daysAfterStart(3).toISOString());
  });

  it('treats a skipped attempt as a failure that still burns the budget', () => {
    const decision = applyDunningAttemptOutcome({ startedAt: START, attemptsMade: 1 }, 'SKIPPED');

    expect(decision.status).toBe('SCHEDULED');
    expect(decision.nextAttemptAt?.toISOString()).toBe(daysAfterStart(7).toISOString());
  });

  it('exhausts the campaign when the last retry fails', () => {
    const decision = applyDunningAttemptOutcome(
      { startedAt: START, attemptsMade: MAX_DUNNING_ATTEMPTS - 1 },
      'FAILED',
    );

    expect(decision.status).toBe('EXHAUSTED');
    expect(decision.nextAttemptAt).toBeNull();
  });

  it('walks a whole campaign from first failure to exhaustion', () => {
    let state = { startedAt: START, attemptsMade: 0 };
    const statuses: string[] = [];

    for (let i = 0; i < MAX_DUNNING_ATTEMPTS; i += 1) {
      const decision = applyDunningAttemptOutcome(state, 'FAILED');
      statuses.push(decision.status);
      state = { startedAt: START, attemptsMade: state.attemptsMade + 1 };
    }

    expect(statuses).toEqual(['SCHEDULED', 'SCHEDULED', 'EXHAUSTED']);
  });
});
