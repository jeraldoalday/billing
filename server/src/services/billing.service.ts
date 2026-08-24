import { ApiError } from '../middleware/errorHandler';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import {
  decideBillingAction,
  firstPeriodAfterTrial,
  nextBillingPeriod,
  shouldStopAfterPeriod,
  type BillingAction,
  type BillingSkipReason,
} from '../domain/billingCycle';
import type { BillingInterval } from '../domain/pricing';
import * as dunningService from './dunning.service';
import * as invoiceService from './invoice.service';
import * as paymentService from './payment.service';
import * as subscriptionService from './subscription.service';
import * as webhookService from './webhook.service';
import type { RunBillingCycleInput } from '../validators/billing';

// The recurring billing runner: the thing that turns "time passed" into
// invoices and charges. Every decision about *what* should happen to a
// subscription comes from src/domain/billingCycle.ts; this service performs
// the side effects, in the order a billing period actually closes:
//
//   1. invoice the period that just ended (this platform bills in arrears,
//      which is the only way a metered plan's usage can be on the invoice),
//   2. finalize it and charge the customer's card,
//   3. move the subscription on to its next period — or stop it, if a
//      cancellation was booked for the period that just closed.
//
// A declined charge is not an error here: src/services/payment.service.ts
// records it and opens a dunning campaign, which owns the subscription from
// that point on (the runner skips PAST_DUE subscriptions until dunning
// resolves them, see decideBillingAction).
//
// Everything is driven by an explicit `now`, so an operator or a test can
// run a cycle as if it were a later instant.

type SubscriptionWithRelations = Awaited<ReturnType<typeof subscriptionService.getSubscription>>;

export type BillingOutcome = 'RENEWED' | 'TRIAL_CONVERTED' | 'CANCELED' | 'SKIPPED' | 'ERRORED';

export type PaymentAttemptStatus = 'SUCCEEDED' | 'FAILED' | 'NOT_ATTEMPTED';

export interface BilledPeriod {
  invoiceId: string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  total: number;
  invoiceStatus: string;
  paymentStatus: PaymentAttemptStatus;
  paymentId: string | null;
  failureCode: string | null;
}

export interface SubscriptionBillingResult {
  subscriptionId: string;
  customerId: string;
  /** The action the domain chose on the first pass over this subscription. */
  action: BillingAction;
  outcome: BillingOutcome;
  /** Why nothing happened, when nothing did. */
  reason: BillingSkipReason | null;
  periods: BilledPeriod[];
  error: string | null;
}

export interface BillingCycleTotals {
  renewed: number;
  trialsConverted: number;
  canceled: number;
  skipped: number;
  errored: number;
  invoicesBilled: number;
  invoicesPaid: number;
  paymentsFailed: number;
  /** Minor currency units invoiced this run, and how much of it was collected. */
  amountBilled: number;
  amountCollected: number;
}

export interface BillingCycleSummary {
  organizationId: string;
  asOf: string;
  subscriptionsConsidered: number;
  totals: BillingCycleTotals;
  results: SubscriptionBillingResult[];
}

// Sweeps every subscription that may have work due and bills it. Sequential
// because each subscription's charge hits the payment gateway, matching how
// src/services/dunning.service.ts runs its retries.
export async function runBillingCycle(
  organizationId: string,
  input: RunBillingCycleInput,
): Promise<BillingCycleSummary> {
  const now = input.asOf ?? new Date();

  // Deliberately a superset of "definitely billable": the query narrows to
  // subscriptions that *might* have something due, and the domain decides
  // what actually happens to each. PAST_DUE rows are included so a run can
  // report that dunning is holding them rather than silently omitting them.
  const candidates = await prisma.subscription.findMany({
    where: {
      organizationId,
      id: input.subscriptionId,
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      OR: [
        { currentPeriodEnd: { lte: now } },
        { trialEnd: { lte: now } },
        { cancelAt: { lte: now } },
      ],
    },
    orderBy: { currentPeriodEnd: 'asc' },
    take: input.limit,
    select: { id: true },
  });

  const results: SubscriptionBillingResult[] = [];
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop -- charges hit the payment gateway; deliberately sequential
    const result = await billSubscription(
      organizationId,
      candidate.id,
      now,
      input.maxPeriodsPerSubscription,
    );
    results.push(result);
  }

  return {
    organizationId,
    asOf: now.toISOString(),
    subscriptionsConsidered: candidates.length,
    totals: summarize(results),
    results,
  };
}

function summarize(results: SubscriptionBillingResult[]): BillingCycleTotals {
  const periods = results.flatMap((result) => result.periods);

  return {
    renewed: results.filter((result) => result.outcome === 'RENEWED').length,
    trialsConverted: results.filter((result) => result.outcome === 'TRIAL_CONVERTED').length,
    canceled: results.filter((result) => result.outcome === 'CANCELED').length,
    skipped: results.filter((result) => result.outcome === 'SKIPPED').length,
    errored: results.filter((result) => result.outcome === 'ERRORED').length,
    invoicesBilled: periods.length,
    invoicesPaid: periods.filter((period) => period.invoiceStatus === 'PAID').length,
    paymentsFailed: periods.filter((period) => period.paymentStatus === 'FAILED').length,
    amountBilled: periods.reduce((sum, period) => sum + period.total, 0),
    amountCollected: periods
      .filter((period) => period.invoiceStatus === 'PAID')
      .reduce((sum, period) => sum + period.total, 0),
  };
}

// Bills one subscription until it has nothing more due, up to `maxPeriods`.
// The loop is what lets the runner catch up: a subscription three periods
// behind (a worker that was down, a customer dunning has just recovered)
// gets one invoice per period it missed, in order, rather than one invoice
// covering a span nobody agreed to.
//
// The subscription is re-read on every pass because each pass mutates it —
// and because a failed charge moves it to PAST_DUE from inside
// chargeInvoice, which is precisely the signal that should stop the loop.
async function billSubscription(
  organizationId: string,
  subscriptionId: string,
  now: Date,
  maxPeriods: number,
): Promise<SubscriptionBillingResult> {
  const periods: BilledPeriod[] = [];
  let action: BillingAction = 'SKIP';
  let outcome: BillingOutcome = 'SKIPPED';
  let reason: BillingSkipReason | null = null;
  let customerId = '';

  try {
    for (let pass = 0; pass < maxPeriods; pass += 1) {
      // eslint-disable-next-line no-await-in-loop -- each pass depends on the state the last one wrote
      const subscription = await subscriptionService.getSubscription(organizationId, subscriptionId);
      customerId = subscription.customerId;

      const decision = decideBillingAction(subscription, now);
      if (pass === 0) {
        action = decision.action;
      }

      if (decision.action === 'SKIP') {
        // Only the first pass explains itself: on a later pass "nothing
        // more is due" is the loop's normal exit, not a reason the
        // subscription went unbilled.
        if (outcome === 'SKIPPED') {
          reason = decision.reason;
        }
        break;
      }

      if (decision.action === 'END_TRIAL') {
        // eslint-disable-next-line no-await-in-loop -- sequential by construction
        await convertTrial(organizationId, subscription);
        outcome = 'TRIAL_CONVERTED';
        // Deliberately not a break: a trial that ended several periods ago
        // still owes invoices for the periods since.
        continue;
      }

      if (decision.action === 'CANCEL_SCHEDULED') {
        // eslint-disable-next-line no-await-in-loop -- sequential by construction
        await applyScheduledCancellation(organizationId, subscription, now);
        outcome = 'CANCELED';
        break;
      }

      // eslint-disable-next-line no-await-in-loop -- the charge must settle before the period advances
      periods.push(await billClosingPeriod(organizationId, subscription, now));
      outcome = 'RENEWED';

      if (shouldStopAfterPeriod(subscription)) {
        // eslint-disable-next-line no-await-in-loop -- sequential by construction
        await applyScheduledCancellation(organizationId, subscription, now);
        outcome = 'CANCELED';
        break;
      }

      // eslint-disable-next-line no-await-in-loop -- sequential by construction
      await advancePeriod(organizationId, subscription);
    }
  } catch (err) {
    // One subscription failing must not abandon the rest of the run, and
    // the failure has to be visible in the summary rather than only in a
    // log line — a job that reports success while a customer went unbilled
    // is worse than one that reports the failure.
    logger.error({ err, subscriptionId, organizationId }, 'Billing cycle failed for a subscription');
    return {
      subscriptionId,
      customerId,
      action,
      outcome: 'ERRORED',
      reason,
      periods,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { subscriptionId, customerId, action, outcome, reason, periods, error: null };
}

// Invoices the period that just closed and tries to collect it.
async function billClosingPeriod(
  organizationId: string,
  subscription: SubscriptionWithRelations,
  now: Date,
): Promise<BilledPeriod> {
  const draft = await findOrCreatePeriodInvoice(organizationId, subscription);
  const invoice = draft.status === 'DRAFT'
    ? await invoiceService.finalizeInvoice(organizationId, draft.id)
    : draft;

  const period = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    periodStart: invoice.periodStart.toISOString(),
    periodEnd: invoice.periodEnd.toISOString(),
    currency: invoice.currency,
    total: invoice.total,
  };

  // Already settled or written off by hand between generation and now.
  if (invoice.status !== 'OPEN') {
    return { ...period, invoiceStatus: invoice.status, paymentStatus: 'NOT_ATTEMPTED', paymentId: null, failureCode: null };
  }

  // Nothing left to collect — a 100%-off coupon, or a period whose
  // proration credits cancelled the plan charge out. Settled directly
  // rather than through the gateway, which is also what lets a free period
  // be billed for a customer with no card on file at all.
  if (invoice.total <= 0) {
    const paid = await invoiceService.markInvoicePaid(organizationId, invoice.id);
    return { ...period, invoiceStatus: paid.status, paymentStatus: 'NOT_ATTEMPTED', paymentId: null, failureCode: null };
  }

  const paymentMethod = await paymentService.defaultPaymentMethodFor(
    organizationId,
    subscription.customerId,
  );

  if (!paymentMethod) {
    // No card to charge. The invoice stays OPEN (it is genuinely owed) and
    // goes into dunning, so the customer is chased on the same schedule as
    // a declined card instead of the debt sitting unnoticed.
    await dunningService
      .startDunning(organizationId, invoice.id, { failureCode: 'no_payment_method', now })
      .catch((err) => {
        logger.error({ err, invoiceId: invoice.id }, 'Failed to open dunning for an uncollectable invoice');
      });

    return {
      ...period,
      invoiceStatus: invoice.status,
      paymentStatus: 'FAILED',
      paymentId: null,
      failureCode: 'no_payment_method',
    };
  }

  const payment = await paymentService.chargeInvoice(
    organizationId,
    invoice.id,
    { paymentMethodId: paymentMethod.id },
    { now },
  );
  const settled = await invoiceService.getInvoice(organizationId, invoice.id);

  return {
    ...period,
    invoiceStatus: settled.status,
    paymentStatus: payment.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
    paymentId: payment.id,
    failureCode: payment.failureCode,
  };
}

// The invoice for the closing period: normally one this call generates, but
// an invoice may already exist for it (an operator generated it by hand, or
// a previous run generated it and died before charging). Reusing it is what
// makes the runner safe to re-run — the alternative, treating the conflict
// as an error, would leave that period permanently unbillable.
async function findOrCreatePeriodInvoice(
  organizationId: string,
  subscription: SubscriptionWithRelations,
) {
  try {
    return await invoiceService.generateInvoice(organizationId, { subscriptionId: subscription.id });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) {
      throw err;
    }

    const existing = await prisma.invoice.findFirst({
      where: {
        organizationId,
        subscriptionId: subscription.id,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
        status: { not: 'VOID' },
      },
      include: { lineItems: true },
    });

    if (!existing) {
      throw err;
    }

    return existing;
  }
}

// Starts the first paid period of a subscription whose trial has run out.
//
// Not src/services/subscription.service.ts#endTrial: that is the "end it
// early, from now" operation, and would move the billing anniversary to
// whenever the worker happened to notice. Here the trial ran its course, so
// the paid period starts at the scheduled trialEnd — and trialEnd is left
// as it was, since it is a record of what the customer was promised.
async function convertTrial(organizationId: string, subscription: SubscriptionWithRelations) {
  const period = firstPeriodAfterTrial(
    subscription,
    subscription.plan.interval as BillingInterval,
  );

  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
      },
    });
    await tx.subscriptionEvent.create({
      data: { subscriptionId: subscription.id, type: 'TRIAL_ENDED' },
    });
  });

  await webhookService.emitEvent(organizationId, 'subscription.updated', {
    subscriptionId: subscription.id,
    customerId: subscription.customerId,
    planId: subscription.planId,
    status: 'ACTIVE',
    currentPeriodStart: period.start.toISOString(),
    currentPeriodEnd: period.end.toISOString(),
    trialEnded: true,
  });
}

// Rolls the subscription into its next period. The bounds come from the
// period that just closed, never from `now`, so a run that happens late
// doesn't shift the customer's billing anniversary.
async function advancePeriod(organizationId: string, subscription: SubscriptionWithRelations) {
  const period = nextBillingPeriod(
    { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd },
    subscription.plan.interval as BillingInterval,
  );

  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { currentPeriodStart: period.start, currentPeriodEnd: period.end },
    });
    await tx.subscriptionEvent.create({
      data: { subscriptionId: subscription.id, type: 'RENEWED' },
    });
  });

  await webhookService.emitEvent(organizationId, 'subscription.renewed', {
    subscriptionId: subscription.id,
    customerId: subscription.customerId,
    planId: subscription.planId,
    currentPeriodStart: period.start.toISOString(),
    currentPeriodEnd: period.end.toISOString(),
  });
}

// Applies a cancellation that was booked for a period end and has now come
// due. Not src/services/subscription.service.ts#cancelSubscription: that
// books a cancellation, whereas this one is carrying out a booking already
// made, and `cancelAt` must keep the date the customer was told rather than
// being overwritten with the moment the worker got to it.
async function applyScheduledCancellation(
  organizationId: string,
  subscription: SubscriptionWithRelations,
  now: Date,
) {
  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELED', canceledAt: now },
    });
    await tx.subscriptionEvent.create({
      data: { subscriptionId: subscription.id, type: 'CANCELED' },
    });
  });

  await webhookService.emitEvent(organizationId, 'subscription.canceled', {
    subscriptionId: subscription.id,
    customerId: subscription.customerId,
    planId: subscription.planId,
    reason: 'scheduled_cancellation',
    cancelAt: subscription.cancelAt?.toISOString() ?? null,
    canceledAt: now.toISOString(),
  });
}
