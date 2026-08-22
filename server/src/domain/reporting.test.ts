import { describe, expect, it } from 'vitest';
import {
  calculateArpu,
  calculateChurnRate,
  calculateRetentionRate,
  monthlyAmount,
  roundRate,
  statusContributesToMrr,
  subscriptionMrr,
  summarizeMrr,
  type MrrSubscription,
} from './reporting';

function flatSubscription(overrides: Partial<MrrSubscription> = {}): MrrSubscription {
  return {
    status: 'ACTIVE',
    plan: { pricingModel: 'FLAT', interval: 'MONTH', flatAmount: 5000 },
    ...overrides,
  };
}

describe('monthlyAmount', () => {
  it('leaves a monthly amount alone', () => {
    expect(monthlyAmount(5000, 'MONTH')).toBe(5000);
  });

  it('spreads a yearly amount across twelve months', () => {
    expect(monthlyAmount(120000, 'YEAR')).toBe(10000);
  });

  it('scales a weekly amount up to a month', () => {
    // 52.18 weeks a year / 12 months = 4.348 weeks a month.
    expect(monthlyAmount(1000, 'WEEK')).toBe(4348);
  });

  it('scales a daily amount up to a month', () => {
    expect(monthlyAmount(100, 'DAY')).toBe(3044);
  });

  it('normalizes daily and yearly prices of the same size to the same MRR', () => {
    // 100 a day for a 365.25-day year is 36525 a year: the two must agree.
    const yearly = monthlyAmount(36525, 'YEAR');
    const daily = monthlyAmount(100, 'DAY');

    expect(Math.abs(yearly - daily)).toBeLessThanOrEqual(1);
  });

  it('rounds to a whole minor currency unit', () => {
    expect(monthlyAmount(1000, 'YEAR')).toBe(83);
  });
});

describe('statusContributesToMrr', () => {
  it('counts subscriptions that are billing or expected to recover', () => {
    expect(statusContributesToMrr('ACTIVE')).toBe(true);
    expect(statusContributesToMrr('PAST_DUE')).toBe(true);
  });

  it('excludes trials, which are not paying yet, and cancellations', () => {
    expect(statusContributesToMrr('TRIALING')).toBe(false);
    expect(statusContributesToMrr('CANCELED')).toBe(false);
  });
});

describe('subscriptionMrr', () => {
  it('reports a flat monthly plan at its price', () => {
    expect(subscriptionMrr(flatSubscription())).toBe(5000);
  });

  it('normalizes a yearly plan onto a monthly basis', () => {
    const yearly = flatSubscription({
      plan: { pricingModel: 'FLAT', interval: 'YEAR', flatAmount: 120000 },
    });

    expect(subscriptionMrr(yearly)).toBe(10000);
  });

  it('reports nothing for a trialing or canceled subscription', () => {
    expect(subscriptionMrr(flatSubscription({ status: 'TRIALING' }))).toBe(0);
    expect(subscriptionMrr(flatSubscription({ status: 'CANCELED' }))).toBe(0);
  });

  it('still counts a past-due subscription we expect dunning to recover', () => {
    expect(subscriptionMrr(flatSubscription({ status: 'PAST_DUE' }))).toBe(5000);
  });

  it('reports nothing for usage-based plans, whose revenue is not committed', () => {
    const metered = flatSubscription({
      plan: { pricingModel: 'USAGE', interval: 'MONTH', flatAmount: null },
    });

    expect(subscriptionMrr(metered)).toBe(0);
  });

  it('nets a percent-off coupon out of the contribution', () => {
    const discounted = flatSubscription({
      discount: { type: 'PERCENT_OFF', percentOff: 25, amountOff: null },
    });

    expect(subscriptionMrr(discounted)).toBe(3750);
  });

  it('normalizes an amount-off coupon onto the same basis as the plan', () => {
    const discounted = flatSubscription({
      plan: { pricingModel: 'FLAT', interval: 'YEAR', flatAmount: 120000 },
      discount: { type: 'AMOUNT_OFF', percentOff: null, amountOff: 12000 },
    });

    // 120000/12 = 10000 a month, less 12000/12 = 1000 a month.
    expect(subscriptionMrr(discounted)).toBe(9000);
  });

  it('never reports negative MRR when a coupon exceeds the plan price', () => {
    const discounted = flatSubscription({
      discount: { type: 'AMOUNT_OFF', percentOff: null, amountOff: 999999 },
    });

    expect(subscriptionMrr(discounted)).toBe(0);
  });
});

describe('summarizeMrr', () => {
  const byInterval = (subscription: MrrSubscription) => ({
    key: subscription.plan.interval,
    label: subscription.plan.interval,
  });

  it('totals MRR and counts the subscriptions behind it', () => {
    const summary = summarizeMrr(
      [flatSubscription(), flatSubscription({ plan: { pricingModel: 'FLAT', interval: 'MONTH', flatAmount: 2500 } })],
      byInterval,
    );

    expect(summary.mrr).toBe(7500);
    expect(summary.subscriptions).toBe(2);
  });

  it('leaves non-revenue subscriptions out of both the total and the count', () => {
    const summary = summarizeMrr([flatSubscription(), flatSubscription({ status: 'CANCELED' })], byInterval);

    expect(summary.mrr).toBe(5000);
    expect(summary.subscriptions).toBe(1);
  });

  it('counts a metered subscription as a subscription contributing zero', () => {
    const metered = flatSubscription({
      plan: { pricingModel: 'USAGE', interval: 'MONTH', flatAmount: null },
    });
    const summary = summarizeMrr([metered], byInterval);

    expect(summary.mrr).toBe(0);
    expect(summary.subscriptions).toBe(1);
  });

  it('groups by the caller-supplied key, biggest first', () => {
    const summary = summarizeMrr(
      [
        flatSubscription(),
        flatSubscription({ plan: { pricingModel: 'FLAT', interval: 'YEAR', flatAmount: 1200000 } }),
      ],
      byInterval,
    );

    expect(summary.breakdown).toEqual([
      { key: 'YEAR', label: 'YEAR', mrr: 100000, subscriptions: 1 },
      { key: 'MONTH', label: 'MONTH', mrr: 5000, subscriptions: 1 },
    ]);
  });

  it('returns an empty summary for no subscriptions', () => {
    expect(summarizeMrr([], byInterval)).toEqual({ mrr: 0, subscriptions: 0, breakdown: [] });
  });
});

describe('calculateChurnRate', () => {
  it('reports the share of the starting cohort that ended', () => {
    expect(calculateChurnRate({ atStart: 200, churned: 10 })).toBe(5);
  });

  it('rounds to two decimal places', () => {
    expect(calculateChurnRate({ atStart: 3, churned: 1 })).toBe(33.33);
  });

  it('reports 0% when there was nothing to lose', () => {
    expect(calculateChurnRate({ atStart: 0, churned: 0 })).toBe(0);
  });

  it('reports 100% when the whole cohort left', () => {
    expect(calculateChurnRate({ atStart: 7, churned: 7 })).toBe(100);
  });
});

describe('calculateRetentionRate', () => {
  it('complements the churn rate exactly', () => {
    const input = { atStart: 3, churned: 1 };

    expect(calculateRetentionRate(input) + calculateChurnRate(input)).toBe(100);
  });

  it('retains everything when nothing churned', () => {
    expect(calculateRetentionRate({ atStart: 40, churned: 0 })).toBe(100);
  });
});

describe('calculateArpu', () => {
  it('spreads MRR over the accounts generating it', () => {
    expect(calculateArpu(100000, 8)).toBe(12500);
  });

  it('rounds to a whole minor currency unit', () => {
    expect(calculateArpu(1000, 3)).toBe(333);
  });

  it('reports 0 rather than dividing by zero accounts', () => {
    expect(calculateArpu(1000, 0)).toBe(0);
  });
});

describe('roundRate', () => {
  it('keeps two decimal places', () => {
    expect(roundRate(12.3456)).toBe(12.35);
    expect(roundRate(100)).toBe(100);
  });
});
