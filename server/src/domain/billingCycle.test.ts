import { describe, expect, it } from 'vitest';
import {
  BILLING_ACTIONS,
  decideBillingAction,
  firstPeriodAfterTrial,
  isPeriodEnded,
  isTrialOver,
  nextBillingPeriod,
  periodsElapsed,
  shouldStopAfterPeriod,
  type BillableSubscription,
} from './billingCycle';

const PERIOD_START = new Date('2026-06-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-07-01T00:00:00.000Z');

function subscription(overrides: Partial<BillableSubscription> = {}): BillableSubscription {
  return {
    status: 'ACTIVE',
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    trialEnd: null,
    cancelAt: null,
    canceledAt: null,
    ...overrides,
  };
}

describe('BILLING_ACTIONS', () => {
  it('is the closed set the runner switches on', () => {
    expect(BILLING_ACTIONS).toEqual(['RENEW', 'END_TRIAL', 'CANCEL_SCHEDULED', 'SKIP']);
  });
});

describe('isPeriodEnded', () => {
  it('treats the period end itself as ended, since periods are closed-open', () => {
    expect(isPeriodEnded(subscription(), PERIOD_END)).toBe(true);
  });

  it('is false a millisecond before the boundary', () => {
    expect(isPeriodEnded(subscription(), new Date(PERIOD_END.getTime() - 1))).toBe(false);
  });
});

describe('isTrialOver', () => {
  it('uses trialEnd when it is set', () => {
    const trialing = subscription({
      status: 'TRIALING',
      trialEnd: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(isTrialOver(trialing, new Date('2026-06-14T23:59:59.000Z'))).toBe(false);
    expect(isTrialOver(trialing, new Date('2026-06-15T00:00:00.000Z'))).toBe(true);
  });

  it('falls back to the period end for a row with no trialEnd', () => {
    const trialing = subscription({ status: 'TRIALING', trialEnd: null });

    expect(isTrialOver(trialing, new Date('2026-06-30T00:00:00.000Z'))).toBe(false);
    expect(isTrialOver(trialing, PERIOD_END)).toBe(true);
  });
});

describe('decideBillingAction', () => {
  it('renews once the period has ended', () => {
    expect(decideBillingAction(subscription(), PERIOD_END)).toEqual({
      action: 'RENEW',
      reason: null,
    });
  });

  it('skips a subscription whose period is still running', () => {
    expect(decideBillingAction(subscription(), new Date('2026-06-20T00:00:00.000Z'))).toEqual({
      action: 'SKIP',
      reason: 'period_not_ended',
    });
  });

  it('skips a canceled subscription', () => {
    const canceled = subscription({ status: 'CANCELED', canceledAt: PERIOD_START });

    expect(decideBillingAction(canceled, PERIOD_END)).toEqual({
      action: 'SKIP',
      reason: 'already_canceled',
    });
  });

  it('leaves a past-due subscription to dunning rather than stacking another invoice', () => {
    const pastDue = subscription({ status: 'PAST_DUE' });

    expect(decideBillingAction(pastDue, new Date('2026-08-01T00:00:00.000Z'))).toEqual({
      action: 'SKIP',
      reason: 'awaiting_payment',
    });
  });

  it('skips a trial that is still running', () => {
    const trialing = subscription({
      status: 'TRIALING',
      trialEnd: new Date('2026-06-15T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(decideBillingAction(trialing, new Date('2026-06-10T00:00:00.000Z'))).toEqual({
      action: 'SKIP',
      reason: 'trial_in_progress',
    });
  });

  it('ends a trial that has run out', () => {
    const trialing = subscription({
      status: 'TRIALING',
      trialEnd: new Date('2026-06-15T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(decideBillingAction(trialing, new Date('2026-06-15T00:00:00.000Z'))).toEqual({
      action: 'END_TRIAL',
      reason: null,
    });
  });

  it('cancels rather than converting a trial that was canceled during it', () => {
    const trialing = subscription({
      status: 'TRIALING',
      trialEnd: new Date('2026-06-15T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-06-15T00:00:00.000Z'),
      cancelAt: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(decideBillingAction(trialing, new Date('2026-06-16T00:00:00.000Z'))).toEqual({
      action: 'CANCEL_SCHEDULED',
      reason: null,
    });
  });

  it('bills the closing period first when a cancellation lands on the period end', () => {
    const canceling = subscription({ cancelAt: PERIOD_END });

    expect(decideBillingAction(canceling, PERIOD_END).action).toBe('RENEW');
  });

  it('cancels mid-period when the cancellation is due but nothing is billable yet', () => {
    const canceling = subscription({ cancelAt: new Date('2026-06-10T00:00:00.000Z') });

    expect(decideBillingAction(canceling, new Date('2026-06-11T00:00:00.000Z'))).toEqual({
      action: 'CANCEL_SCHEDULED',
      reason: null,
    });
  });

  it('leaves a scheduled cancellation alone until its date arrives', () => {
    const canceling = subscription({ cancelAt: PERIOD_END });

    expect(decideBillingAction(canceling, new Date('2026-06-20T00:00:00.000Z'))).toEqual({
      action: 'SKIP',
      reason: 'period_not_ended',
    });
  });
});

describe('shouldStopAfterPeriod', () => {
  it('stops when the cancellation was booked for the period that just closed', () => {
    expect(shouldStopAfterPeriod({ cancelAt: PERIOD_END, currentPeriodEnd: PERIOD_END })).toBe(true);
  });

  it('stops when the cancellation was booked even earlier', () => {
    expect(
      shouldStopAfterPeriod({ cancelAt: PERIOD_START, currentPeriodEnd: PERIOD_END }),
    ).toBe(true);
  });

  it('rolls on when the cancellation is booked for a later period', () => {
    expect(
      shouldStopAfterPeriod({
        cancelAt: new Date('2026-08-01T00:00:00.000Z'),
        currentPeriodEnd: PERIOD_END,
      }),
    ).toBe(false);
  });

  it('rolls on when nothing is scheduled', () => {
    expect(shouldStopAfterPeriod({ cancelAt: null, currentPeriodEnd: PERIOD_END })).toBe(false);
  });
});

describe('nextBillingPeriod', () => {
  it('starts the next period exactly where the last one ended', () => {
    const next = nextBillingPeriod({ start: PERIOD_START, end: PERIOD_END }, 'MONTH');

    expect(next.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(next.end.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('tiles periods without drifting, however late the runner is', () => {
    let period = { start: PERIOD_START, end: PERIOD_END };
    for (let i = 0; i < 3; i += 1) {
      period = nextBillingPeriod(period, 'MONTH');
    }

    expect(period.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('follows the calendar for a month that starts on the 31st', () => {
    const period = {
      start: new Date('2026-01-31T00:00:00.000Z'),
      end: new Date('2026-02-28T00:00:00.000Z'),
    };

    expect(nextBillingPeriod(period, 'MONTH').end.toISOString()).toBe('2026-03-28T00:00:00.000Z');
  });

  it('handles every interval the platform bills on', () => {
    const period = { start: PERIOD_START, end: PERIOD_END };

    expect(nextBillingPeriod(period, 'DAY').end.toISOString()).toBe('2026-07-02T00:00:00.000Z');
    expect(nextBillingPeriod(period, 'WEEK').end.toISOString()).toBe('2026-07-08T00:00:00.000Z');
    expect(nextBillingPeriod(period, 'YEAR').end.toISOString()).toBe('2027-07-01T00:00:00.000Z');
  });
});

describe('firstPeriodAfterTrial', () => {
  it('starts the first paid period at the scheduled trial end, not at the run time', () => {
    const trialing = subscription({
      status: 'TRIALING',
      trialEnd: new Date('2026-06-15T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-06-15T00:00:00.000Z'),
    });

    const period = firstPeriodAfterTrial(trialing, 'MONTH');

    expect(period.start.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('falls back to the period end when no trialEnd was recorded', () => {
    const trialing = subscription({ status: 'TRIALING', trialEnd: null });

    expect(firstPeriodAfterTrial(trialing, 'MONTH').start.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });
});

describe('periodsElapsed', () => {
  it('is zero while the current period is still running', () => {
    expect(periodsElapsed(subscription(), 'MONTH', new Date('2026-06-15T00:00:00.000Z'))).toBe(0);
  });

  it('counts one closed period at the boundary', () => {
    expect(periodsElapsed(subscription(), 'MONTH', PERIOD_END)).toBe(1);
  });

  it('counts every period a dormant subscription is behind', () => {
    expect(periodsElapsed(subscription(), 'MONTH', new Date('2026-10-05T00:00:00.000Z'))).toBe(4);
  });

  it('never exceeds the cap, however far behind the subscription is', () => {
    expect(periodsElapsed(subscription(), 'DAY', new Date('2030-01-01T00:00:00.000Z'), 5)).toBe(5);
  });
});
