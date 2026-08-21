import { ApiError } from '../middleware/errorHandler';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import {
  applyDunningAttemptOutcome,
  decideNextDunningStep,
  isTerminalDunningStatus,
  nextDunningAttemptAt,
  type DunningAttemptOutcome,
  type DunningStatus,
} from '../domain/dunning';
import * as paymentService from './payment.service';
import * as webhookService from './webhook.service';
import type { ListDunningCampaignsQuery, RunDunningInput } from '../validators/dunning';

// Recovery of failed payments: opening a campaign when a charge fails,
// running each scheduled retry, and giving up (canceling the subscription)
// once the schedule in src/domain/dunning.ts is spent. All scheduling
// decisions come from that pure module — this service only persists them
// and performs the side effects (charging, canceling, emitting events).
//
// This module and payment.service reference each other on purpose: a failed
// charge opens a campaign, and a campaign's retry is itself a charge. Both
// directions are called at runtime, never at module load, so the cycle is
// resolved by the time either function actually runs.

const WITH_RELATIONS = {
  invoice: true,
  subscription: { include: { customer: true } },
  attempts: { orderBy: { attemptNumber: 'asc' } },
} as const;

type CampaignWithRelations = NonNullable<
  Awaited<ReturnType<typeof prisma.dunningCampaign.findFirst<{ include: typeof WITH_RELATIONS }>>>
>;

// Scoping the lookup to organizationId means a campaign belonging to another
// org 404s exactly like one that doesn't exist, rather than leaking a 403
// that would confirm the id is real.
export async function getDunningCampaign(organizationId: string, campaignId: string) {
  const campaign = await prisma.dunningCampaign.findFirst({
    where: { id: campaignId, organizationId },
    include: WITH_RELATIONS,
  });

  if (!campaign) {
    throw ApiError.notFound('Dunning campaign not found');
  }

  return campaign;
}

export async function listDunningCampaigns(organizationId: string, query: ListDunningCampaignsQuery) {
  return prisma.dunningCampaign.findMany({
    where: {
      organizationId,
      status: query.status,
      subscriptionId: query.subscriptionId,
      invoiceId: query.invoiceId,
    },
    include: WITH_RELATIONS,
    orderBy: { createdAt: 'desc' },
  });
}

export interface StartDunningOptions {
  failureCode?: string | null;
  now?: Date;
}

// Opens (or re-uses) the recovery campaign for an invoice whose payment just
// failed, and marks the subscription PAST_DUE. Idempotent by design: a
// second failure on an invoice that is already in dunning records the newer
// failure code but must not restart the schedule, or a customer whose card
// keeps failing would be retried forever.
export async function startDunning(
  organizationId: string,
  invoiceId: string,
  options: StartDunningOptions = {},
) {
  const now = options.now ?? new Date();

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
  });
  if (!invoice) {
    throw ApiError.notFound('Invoice not found');
  }
  if (invoice.status !== 'OPEN') {
    throw ApiError.conflict(`Cannot start dunning for an invoice with status ${invoice.status}`);
  }

  const existing = await prisma.dunningCampaign.findUnique({
    where: { invoiceId: invoice.id },
    include: WITH_RELATIONS,
  });
  if (existing) {
    if (isTerminalDunningStatus(existing.status as DunningStatus)) {
      return existing;
    }

    return prisma.dunningCampaign.update({
      where: { id: existing.id },
      data: { lastFailureCode: options.failureCode ?? existing.lastFailureCode },
      include: WITH_RELATIONS,
    });
  }

  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.dunningCampaign.create({
      data: {
        organizationId,
        invoiceId: invoice.id,
        subscriptionId: invoice.subscriptionId,
        status: 'SCHEDULED',
        attemptsMade: 0,
        startedAt: now,
        nextAttemptAt: nextDunningAttemptAt(now, 0),
        lastFailureCode: options.failureCode ?? null,
      },
      include: WITH_RELATIONS,
    });

    // A canceled subscription stays canceled — dunning on a leftover open
    // invoice shouldn't quietly revive it.
    if (created.subscription.status !== 'CANCELED') {
      await tx.subscription.update({
        where: { id: created.subscriptionId },
        data: { status: 'PAST_DUE' },
      });
      await tx.subscriptionEvent.create({
        data: { subscriptionId: created.subscriptionId, type: 'PAST_DUE' },
      });
    }

    return created;
  });

  await webhookService.emitEvent(organizationId, 'dunning.started', {
    campaignId: campaign.id,
    invoiceId: campaign.invoiceId,
    subscriptionId: campaign.subscriptionId,
    nextAttemptAt: campaign.nextAttemptAt?.toISOString() ?? null,
    failureCode: campaign.lastFailureCode,
  });
  await webhookService.emitEvent(organizationId, 'subscription.updated', {
    subscriptionId: campaign.subscriptionId,
    status: 'PAST_DUE',
  });

  return campaign;
}

// The card a retry should be charged against: the customer's default, or
// their most recently added one if none is marked default (a customer who
// added a card before defaults existed still deserves a retry).
async function paymentMethodForRetry(organizationId: string, customerId: string) {
  return prisma.paymentMethod.findFirst({
    where: { organizationId, customerId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
}

async function resolveCampaign(
  campaign: CampaignWithRelations,
  status: DunningStatus,
  now: Date,
  extra: { attemptsMade?: number; lastFailureCode?: string | null } = {},
) {
  return prisma.dunningCampaign.update({
    where: { id: campaign.id },
    data: {
      status,
      resolvedAt: now,
      nextAttemptAt: null,
      attemptsMade: extra.attemptsMade ?? campaign.attemptsMade,
      lastFailureCode: extra.lastFailureCode ?? campaign.lastFailureCode,
    },
    include: WITH_RELATIONS,
  });
}

// Giving up: the subscription is canceled outright (not at period end — the
// customer has already had a week of retries) and the invoice is left OPEN
// rather than voided, since it remains genuinely owed.
async function cancelSubscriptionForExhaustedDunning(campaign: CampaignWithRelations, now: Date) {
  if (campaign.subscription.status === 'CANCELED') {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: campaign.subscriptionId },
      data: { status: 'CANCELED', canceledAt: now, cancelAt: now },
    });
    await tx.subscriptionEvent.create({
      data: { subscriptionId: campaign.subscriptionId, type: 'CANCELED' },
    });
  });

  await webhookService.emitEvent(campaign.organizationId, 'subscription.canceled', {
    subscriptionId: campaign.subscriptionId,
    reason: 'dunning_exhausted',
    canceledAt: now.toISOString(),
  });
}

export interface RunAttemptOptions {
  now?: Date;
  /** Ignore the schedule and retry immediately — what the manual "retry now" endpoint uses. */
  force?: boolean;
}

export interface DunningAttemptResult {
  campaign: CampaignWithRelations;
  /** Null when the campaign was not due, or resolved without charging anything. */
  outcome: DunningAttemptOutcome | null;
}

// Runs (at most) one scheduled retry for a campaign and applies its outcome.
// Returns the campaign untouched when the next retry isn't due yet, so the
// sweep in runDueDunning can call this for every campaign without having to
// re-implement the schedule check itself.
export async function runDunningAttempt(
  organizationId: string,
  campaignId: string,
  options: RunAttemptOptions = {},
): Promise<DunningAttemptResult> {
  const now = options.now ?? new Date();
  const campaign = await getDunningCampaign(organizationId, campaignId);

  if (isTerminalDunningStatus(campaign.status as DunningStatus)) {
    throw ApiError.conflict(`Dunning campaign is already ${campaign.status}`);
  }

  // The invoice may have been settled or written off since the campaign was
  // opened (paid by hand, charged with a different card, voided). Checking
  // here rather than only after a failed charge means we never re-charge a
  // customer who has already paid.
  if (campaign.invoice.status === 'PAID') {
    return { campaign: await recoverCampaign(campaign, now), outcome: null };
  }
  if (campaign.invoice.status === 'VOID') {
    const resolved = await resolveCampaign(campaign, 'CANCELED', now);
    return { campaign: resolved, outcome: null };
  }

  // The subscription may have been canceled since the campaign opened (by
  // the customer, or by support). Retrying its card anyway would keep
  // charging someone who has already left, so the campaign is simply called
  // off — the invoice stays OPEN, since the amount is still owed.
  if (campaign.subscription.status === 'CANCELED') {
    const resolved = await resolveCampaign(campaign, 'CANCELED', now);
    return { campaign: resolved, outcome: null };
  }

  const decision = decideNextDunningStep(campaign, now);

  if (decision.status === 'EXHAUSTED') {
    const resolved = await resolveCampaign(campaign, 'EXHAUSTED', now);
    await cancelSubscriptionForExhaustedDunning(campaign, now);
    await emitExhausted(resolved);
    return { campaign: resolved, outcome: null };
  }

  if (!decision.shouldAttempt && !options.force) {
    return { campaign, outcome: null };
  }

  const paymentMethod = await paymentMethodForRetry(organizationId, campaign.subscription.customerId);

  let outcome: DunningAttemptOutcome = 'SKIPPED';
  let failureCode: string | null = 'no_payment_method';
  let paymentId: string | null = null;

  if (paymentMethod) {
    // chargeInvoice records its own Payment row and emits payment.* events;
    // a decline is an expected outcome here, not an error, so only genuinely
    // unexpected failures (e.g. the invoice changing status underneath us)
    // propagate.
    const payment = await paymentService.chargeInvoice(organizationId, campaign.invoiceId, {
      paymentMethodId: paymentMethod.id,
    });
    outcome = payment.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
    failureCode = payment.failureCode;
    paymentId = payment.id;
  }

  const attemptNumber = campaign.attemptsMade + 1;
  await prisma.dunningAttempt.create({
    data: {
      campaignId: campaign.id,
      attemptNumber,
      scheduledFor: decision.nextAttemptAt ?? now,
      attemptedAt: now,
      outcome,
      failureCode,
      paymentId,
    },
  });

  const next = applyDunningAttemptOutcome(campaign, outcome);

  if (next.status === 'RECOVERED') {
    return { campaign: await recoverCampaign(campaign, now, attemptNumber), outcome };
  }

  if (next.status === 'EXHAUSTED') {
    const resolved = await resolveCampaign(campaign, 'EXHAUSTED', now, {
      attemptsMade: attemptNumber,
      lastFailureCode: failureCode,
    });
    await cancelSubscriptionForExhaustedDunning(campaign, now);
    await emitExhausted(resolved);
    return { campaign: resolved, outcome };
  }

  const updated = await prisma.dunningCampaign.update({
    where: { id: campaign.id },
    data: {
      attemptsMade: attemptNumber,
      nextAttemptAt: next.nextAttemptAt,
      lastFailureCode: failureCode,
    },
    include: WITH_RELATIONS,
  });

  await webhookService.emitEvent(organizationId, 'dunning.attempt_failed', {
    campaignId: updated.id,
    invoiceId: updated.invoiceId,
    subscriptionId: updated.subscriptionId,
    attemptNumber,
    failureCode,
    nextAttemptAt: updated.nextAttemptAt?.toISOString() ?? null,
  });

  return { campaign: updated, outcome };
}

// Recovery: the invoice is settled, so the campaign closes and the
// subscription returns to ACTIVE from PAST_DUE. A subscription that was
// canceled in the meantime stays canceled.
async function recoverCampaign(campaign: CampaignWithRelations, now: Date, attemptsMade?: number) {
  // A retry that succeeds settles the invoice, and settling an invoice
  // recovers its campaign (see recoverDunningForInvoice), so by the time the
  // attempt's own outcome is applied the campaign is often already
  // recovered. Re-reading here keeps that from emitting a second
  // dunning.recovered event and a duplicate DUNNING_RECOVERED audit entry —
  // only the attempt count still needs writing.
  const fresh = await prisma.dunningCampaign.findUnique({
    where: { id: campaign.id },
    include: WITH_RELATIONS,
  });
  if (!fresh) {
    return campaign;
  }
  if (isTerminalDunningStatus(fresh.status as DunningStatus)) {
    if (attemptsMade === undefined || fresh.attemptsMade === attemptsMade) {
      return fresh;
    }
    return prisma.dunningCampaign.update({
      where: { id: fresh.id },
      data: { attemptsMade },
      include: WITH_RELATIONS,
    });
  }

  const resolved = await resolveCampaign(campaign, 'RECOVERED', now, { attemptsMade });

  if (fresh.subscription.status === 'PAST_DUE') {
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: campaign.subscriptionId },
        data: { status: 'ACTIVE' },
      });
      await tx.subscriptionEvent.create({
        data: { subscriptionId: campaign.subscriptionId, type: 'DUNNING_RECOVERED' },
      });
    });

    await webhookService.emitEvent(campaign.organizationId, 'subscription.updated', {
      subscriptionId: campaign.subscriptionId,
      status: 'ACTIVE',
    });
  }

  await webhookService.emitEvent(campaign.organizationId, 'dunning.recovered', {
    campaignId: resolved.id,
    invoiceId: resolved.invoiceId,
    subscriptionId: resolved.subscriptionId,
    attemptsMade: resolved.attemptsMade,
  });

  return resolved;
}

// Closes an in-flight campaign because its invoice has been settled, from
// wherever that happened: a dunning retry, a manual charge with a different
// card, or an administrator marking the invoice paid. Called by
// src/services/invoice.service.ts on the OPEN -> PAID transition, which is
// the one place every settlement funnels through, so a customer who pays
// never stays PAST_DUE waiting for the next sweep to notice.
export async function recoverDunningForInvoice(
  organizationId: string,
  invoiceId: string,
  now: Date = new Date(),
) {
  const campaign = await prisma.dunningCampaign.findFirst({
    where: { invoiceId, organizationId },
    include: WITH_RELATIONS,
  });

  if (!campaign || isTerminalDunningStatus(campaign.status as DunningStatus)) {
    return null;
  }

  return recoverCampaign(campaign, now);
}

async function emitExhausted(campaign: CampaignWithRelations) {
  await webhookService.emitEvent(campaign.organizationId, 'dunning.exhausted', {
    campaignId: campaign.id,
    invoiceId: campaign.invoiceId,
    subscriptionId: campaign.subscriptionId,
    attemptsMade: campaign.attemptsMade,
    lastFailureCode: campaign.lastFailureCode,
  });
}

// Sweeps every campaign whose retry is due. Day 10's background worker will
// call this on a schedule; the /dunning/run endpoint is what makes it
// operable (and testable against a supplied `asOf`) before then. Sequential
// because each attempt hits the payment gateway.
export async function runDueDunning(organizationId: string, input: RunDunningInput) {
  const now = input.asOf ?? new Date();

  const due = await prisma.dunningCampaign.findMany({
    where: {
      organizationId,
      status: 'SCHEDULED',
      nextAttemptAt: { lte: now },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: input.limit,
  });

  const results: DunningAttemptResult[] = [];
  for (const campaign of due) {
    // eslint-disable-next-line no-await-in-loop -- retries hit the payment gateway; deliberately sequential
    const result = await runDunningAttempt(organizationId, campaign.id, { now }).catch((err) => {
      logger.error({ err, campaignId: campaign.id }, 'Dunning attempt failed');
      return null;
    });
    if (result) {
      results.push(result);
    }
  }

  return results;
}

// Calls off an in-flight campaign without canceling the subscription — for
// when the amount was settled outside the system (a bank transfer, a credit)
// and retrying the card would be wrong.
export async function cancelDunning(organizationId: string, campaignId: string, now: Date = new Date()) {
  const campaign = await getDunningCampaign(organizationId, campaignId);

  if (isTerminalDunningStatus(campaign.status as DunningStatus)) {
    throw ApiError.conflict(`Dunning campaign is already ${campaign.status}`);
  }

  return resolveCampaign(campaign, 'CANCELED', now);
}
