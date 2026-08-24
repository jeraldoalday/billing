// What the recurring billing runner should do with one subscription at a
// given instant, and where its next billing period lands. Kept pure so the
// "is anything owed, and what happens next" reasoning is testable without a
// database, a gateway or a real clock — src/services/billing.service.ts
// performs the side effects these decisions describe.

import type { BillingInterval } from './pricing';
import { addInterval } from './subscription';
import type { SubscriptionStatus } from './subscription';

// What the runner does with a subscription on this pass.
//
// - RENEW: the billing period has ended, so the period just closed is
//   invoiced and the subscription moves on to the next one. This platform
//   bills in arrears: an invoice covers the period that has *finished*,
//   which is the only way a metered plan's usage (Day 7) can be on it.
// - END_TRIAL: a trial has run out, so the subscription starts paying. No
//   invoice is produced here — the first paid period is billed when it
//   ends, like every other period.
// - CANCEL_SCHEDULED: a cancellation booked for period end has come due.
// - SKIP: nothing to do yet.
export const BILLING_ACTIONS = ['RENEW', 'END_TRIAL', 'CANCEL_SCHEDULED', 'SKIP'] as const;
export type BillingAction = (typeof BILLING_ACTIONS)[number];

// Why the runner made its choice. Carried on the decision (and out through
// the run summary) so an operator looking at "nothing happened" can tell a
// subscription that isn't due yet from one that dunning has taken over.
export const BILLING_SKIP_REASONS = [
  'period_not_ended',
  'trial_in_progress',
  'awaiting_payment',
  'already_canceled',
] as const;
export type BillingSkipReason = (typeof BILLING_SKIP_REASONS)[number];

export interface BillableSubscription {
  status: SubscriptionStatus | string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  cancelAt: Date | null;
  canceledAt: Date | null;
}

export interface BillingDecision {
  action: BillingAction;
  reason: BillingSkipReason | null;
}

function decision(action: BillingAction, reason: BillingSkipReason | null = null): BillingDecision {
  return { action, reason };
}

function hasReached(instant: Date | null, now: Date): boolean {
  return instant !== null && instant.getTime() <= now.getTime();
}

// A period boundary is reached the moment the clock hits it: periods are
// closed-open ([start, end)) everywhere in this codebase, so an instant
// equal to `currentPeriodEnd` already belongs to the next period.
export function isPeriodEnded(subscription: { currentPeriodEnd: Date }, now: Date): boolean {
  return hasReached(subscription.currentPeriodEnd, now);
}

// Whether a trial has run out. `trialEnd` is authoritative when set, but a
// TRIALING subscription's period end mirrors it (see
// src/services/subscription.service.ts#createSubscription), so the period
// end is a safe fallback for a row written before trialEnd existed.
export function isTrialOver(subscription: BillableSubscription, now: Date): boolean {
  return hasReached(subscription.trialEnd ?? subscription.currentPeriodEnd, now);
}

// The single decision the runner acts on.
//
// PAST_DUE is deliberately skipped rather than renewed: dunning
// (src/domain/dunning.ts) owns a subscription whose payment failed, and
// stacking a second invoice on a customer who hasn't paid the first would
// both double the amount being retried and make the eventual cancellation
// arrive with two open invoices. When dunning recovers the subscription to
// ACTIVE, the next run bills every period that elapsed in the meantime (the
// runner catches up rather than skipping), so nothing is lost by waiting.
export function decideBillingAction(subscription: BillableSubscription, now: Date): BillingDecision {
  if (subscription.status === 'CANCELED') {
    return decision('SKIP', 'already_canceled');
  }

  if (subscription.status === 'TRIALING') {
    if (!isTrialOver(subscription, now)) {
      return decision('SKIP', 'trial_in_progress');
    }
    // A trial that was canceled never becomes a paying subscription: there
    // is nothing to invoice for a trial period, so the cancellation is all
    // that is left to apply.
    return hasReached(subscription.cancelAt, now)
      ? decision('CANCEL_SCHEDULED')
      : decision('END_TRIAL');
  }

  if (subscription.status === 'PAST_DUE') {
    return decision('SKIP', 'awaiting_payment');
  }

  if (isPeriodEnded(subscription, now)) {
    return decision('RENEW');
  }

  // A cancellation is normally booked for period end, so it comes due in
  // the same pass that bills the final period (see
  // shouldStopAfterPeriod below). This branch covers one booked for an
  // earlier instant — a support-set date, or a schedule shortened after
  // the fact — where there is nothing left to bill first.
  if (hasReached(subscription.cancelAt, now)) {
    return decision('CANCEL_SCHEDULED');
  }

  return decision('SKIP', 'period_not_ended');
}

// After the closing period has been invoiced, does the subscription stop
// instead of rolling into another period? A cancellation booked at or
// before the period that just closed has now come due — the customer paid
// for the period they used and owes nothing further.
export function shouldStopAfterPeriod(
  subscription: { cancelAt: Date | null; currentPeriodEnd: Date },
): boolean {
  return (
    subscription.cancelAt !== null &&
    subscription.cancelAt.getTime() <= subscription.currentPeriodEnd.getTime()
  );
}

export interface BillingPeriod {
  start: Date;
  end: Date;
}

// The period that follows the one given. Anchored on the previous period's
// end rather than on `now`, so a run that happens late (a worker that was
// down for a day, an operator sweeping by hand) doesn't shift the
// subscription's billing anniversary — the periods tile exactly.
export function nextBillingPeriod(period: BillingPeriod, interval: BillingInterval): BillingPeriod {
  return { start: period.end, end: addInterval(period.end, interval) };
}

// The first paid period of a subscription whose trial has just ended.
// Starts at the scheduled trial end, not at `now`, for the same reason
// nextBillingPeriod anchors on the period end: when the runner notices
// shouldn't change what the customer is billed for.
export function firstPeriodAfterTrial(
  subscription: BillableSubscription,
  interval: BillingInterval,
): BillingPeriod {
  const start = subscription.trialEnd ?? subscription.currentPeriodEnd;
  return { start, end: addInterval(start, interval) };
}

// How many whole periods have closed between `currentPeriodEnd` and `now` —
// i.e. how many invoices a subscription is behind. Bounded by `cap` so a
// row with a corrupt period (an end date years in the past, an interval
// that somehow doesn't advance) can't turn one pass of the runner into an
// unbounded loop.
export function periodsElapsed(
  subscription: { currentPeriodEnd: Date },
  interval: BillingInterval,
  now: Date,
  cap = 24,
): number {
  let count = 0;
  let end = subscription.currentPeriodEnd;

  while (count < cap && end.getTime() <= now.getTime()) {
    const next = addInterval(end, interval);
    // Defensive: a non-advancing interval would spin forever otherwise.
    if (next.getTime() <= end.getTime()) {
      break;
    }
    end = next;
    count += 1;
  }

  return count;
}
