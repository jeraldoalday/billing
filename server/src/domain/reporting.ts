import type { BillingInterval } from './pricing';

// Pure revenue math: normalizing plan prices onto a common monthly basis,
// and the three headline SaaS metrics (MRR, churn, ARPU) derived from
// counts and amounts a caller has already fetched. No I/O and no Prisma
// types, so every rule below is testable against constructed numbers — see
// src/services/reporting.service.ts for the queries that feed it.
//
// Amounts are integer minor currency units (e.g. cents); rates are
// percentages (e.g. 12.5 for 12.5%).

// Days in an average month, used to put DAY/WEEK plans on a monthly basis.
// 365.25/12 rather than 30, so a daily plan and a yearly plan of the same
// real price normalize to the same MRR instead of drifting apart by the
// 30-vs-365 mismatch.
const DAYS_PER_MONTH = 365.25 / 12;
const WEEKS_PER_MONTH = DAYS_PER_MONTH / 7;

// A recurring amount restated as monthly recurring revenue. Rounded to a
// whole minor unit at the end: MRR is a reporting figure, and carrying
// fractional cents through a sum of thousands of subscriptions would make
// the total depend on the order it was added up in.
export function monthlyAmount(amount: number, interval: BillingInterval): number {
  switch (interval) {
    case 'DAY':
      return Math.round(amount * DAYS_PER_MONTH);
    case 'WEEK':
      return Math.round(amount * WEEKS_PER_MONTH);
    case 'MONTH':
      return Math.round(amount);
    case 'YEAR':
      return Math.round(amount / 12);
  }
}

// Subscription statuses that contribute to MRR. A TRIALING subscription is
// not yet paying anything and a CANCELED one has stopped; a PAST_DUE one is
// still a live billing relationship we expect to recover (that is exactly
// what Day 8's dunning campaigns are for), so dropping it from MRR would
// make a payment blip look like churn.
const REVENUE_STATUSES: readonly string[] = ['ACTIVE', 'PAST_DUE'];

export function statusContributesToMrr(status: string): boolean {
  return REVENUE_STATUSES.includes(status);
}

export interface MrrSubscription {
  status: string;
  plan: {
    pricingModel: string;
    interval: string;
    flatAmount: number | null;
  };
  // The coupon still discounting this subscription's invoices, if any.
  // Applied to MRR because MRR is what we actually expect to bill, not
  // list price — a customer on 50% off contributes half.
  discount?: {
    type: string;
    percentOff: number | null;
    amountOff: number | null;
  } | null;
}

// One subscription's contribution to MRR. Only FLAT plans contribute: a
// USAGE/TIERED subscription's revenue isn't recurring or known in advance,
// so committing it to MRR would be forecasting consumption rather than
// reporting a contract. (Their revenue still shows up in the paid-invoice
// figures from src/services/reporting.service.ts.)
export function subscriptionMrr(subscription: MrrSubscription): number {
  if (!statusContributesToMrr(subscription.status)) {
    return 0;
  }

  const { plan } = subscription;
  if (plan.pricingModel !== 'FLAT') {
    return 0;
  }

  const gross = monthlyAmount(plan.flatAmount ?? 0, plan.interval as BillingInterval);
  if (!subscription.discount) {
    return gross;
  }

  const discount =
    subscription.discount.type === 'PERCENT_OFF'
      ? Math.round((gross * (subscription.discount.percentOff ?? 0)) / 100)
      : // An amount-off coupon comes off each invoice, so it is restated
        // onto the same monthly basis as the plan it discounts.
        monthlyAmount(subscription.discount.amountOff ?? 0, plan.interval as BillingInterval);

  return Math.max(0, gross - discount);
}

export interface MrrBreakdownEntry {
  key: string;
  label: string;
  mrr: number;
  subscriptions: number;
}

// Totals MRR across subscriptions and, in the same pass, groups it by a
// caller-chosen key (plan id, interval, currency). Entries come back
// highest-MRR first so the biggest contributors read off the top; ties fall
// back to the key so the order is stable between calls.
export function summarizeMrr<T extends MrrSubscription>(
  subscriptions: readonly T[],
  groupBy: (subscription: T) => { key: string; label: string },
): { mrr: number; subscriptions: number; breakdown: MrrBreakdownEntry[] } {
  const groups = new Map<string, MrrBreakdownEntry>();
  let mrr = 0;
  let counted = 0;

  for (const subscription of subscriptions) {
    if (!statusContributesToMrr(subscription.status)) {
      continue;
    }

    const amount = subscriptionMrr(subscription);
    const { key, label } = groupBy(subscription);
    const entry = groups.get(key) ?? { key, label, mrr: 0, subscriptions: 0 };
    entry.mrr += amount;
    entry.subscriptions += 1;
    groups.set(key, entry);

    mrr += amount;
    counted += 1;
  }

  const breakdown = [...groups.values()].sort((a, b) => b.mrr - a.mrr || a.key.localeCompare(b.key));

  return { mrr, subscriptions: counted, breakdown };
}

// Rounds a rate to two decimal places. Percentages are reported, not
// summed, so unlike money they can keep a fraction — two places is enough
// to tell 3.33% from 3.34% without implying precision the underlying counts
// don't have.
export function roundRate(rate: number): number {
  return Math.round(rate * 100) / 100;
}

export interface ChurnInput {
  /** How many subscriptions (or customers) were live at the start of the window. */
  atStart: number;
  /** How many of that starting cohort ended during the window. */
  churned: number;
}

// Churn rate as a percentage of the cohort that was live when the window
// opened. Measured against the *starting* cohort, not the average or ending
// one: anything that both started and ended inside the window was never
// part of what we set out to retain, and counting it would let a burst of
// signups distort the figure in either direction.
//
// An empty cohort churns 0%, not NaN — there was nothing to lose.
export function calculateChurnRate({ atStart, churned }: ChurnInput): number {
  if (atStart <= 0) {
    return 0;
  }
  return roundRate((churned / atStart) * 100);
}

// Retention is the complement of churn, computed from the same rounded
// figure so the two always add to exactly 100 in a report.
export function calculateRetentionRate(input: ChurnInput): number {
  return roundRate(100 - calculateChurnRate(input));
}

// Average revenue per user: recurring revenue spread over the accounts
// actually generating it. Rounded to a whole minor unit like the MRR it
// comes from; zero accounts gives 0 rather than a division by zero.
export function calculateArpu(mrr: number, accounts: number): number {
  if (accounts <= 0) {
    return 0;
  }
  return Math.round(mrr / accounts);
}

export interface SubscriptionLifespan {
  createdAt: Date;
  canceledAt: Date | null;
}

// Whether a subscription was a live billing relationship at an instant.
// `canceledAt` is the moment it stopped, so a subscription canceled exactly
// at `at` was already gone by then — the same convention every period
// boundary in this codebase uses (start inclusive, end exclusive), which is
// what keeps a subscription from being counted in two adjacent windows.
export function wasLiveAt(subscription: SubscriptionLifespan, at: Date): boolean {
  if (subscription.createdAt.getTime() > at.getTime()) {
    return false;
  }
  return subscription.canceledAt === null || subscription.canceledAt.getTime() > at.getTime();
}

// Whether a subscription ended inside [from, to).
export function churnedBetween(subscription: SubscriptionLifespan, from: Date, to: Date): boolean {
  const { canceledAt } = subscription;
  if (canceledAt === null) {
    return false;
  }
  return canceledAt.getTime() >= from.getTime() && canceledAt.getTime() < to.getTime();
}

// Splits a set of subscriptions into the cohort that was live when a window
// opened and the part of that cohort which left before it closed. Anything
// that both started and ended inside the window is in neither figure — see
// calculateChurnRate for why the starting cohort is what churn is measured
// against.
export function cohortForWindow<T extends SubscriptionLifespan>(
  subscriptions: readonly T[],
  from: Date,
  to: Date,
): { atStart: T[]; churned: T[] } {
  const atStart = subscriptions.filter((subscription) => wasLiveAt(subscription, from));
  return {
    atStart,
    churned: atStart.filter((subscription) => churnedBetween(subscription, from, to)),
  };
}
