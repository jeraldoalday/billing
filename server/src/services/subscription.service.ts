import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { calculateProration, periodAmountForProration, type ProrationResult } from '../domain/proration';
import { addInterval } from '../domain/subscription';
import type { BillingInterval } from '../domain/pricing';
import * as customerService from './customer.service';
import * as planService from './plan.service';
import { TIERS_ORDERED } from './plan.service';
import type {
  CancelSubscriptionInput,
  ChangeSubscriptionPlanInput,
  CreateSubscriptionInput,
  ListSubscriptionsQuery,
} from '../validators/subscription';

const WITH_RELATIONS = {
  customer: true,
  plan: { include: TIERS_ORDERED },
};

export async function createSubscription(organizationId: string, input: CreateSubscriptionInput) {
  // Both throw a 404 if the id doesn't exist or belongs to another org,
  // which also keeps a subscription from ever pointing at another org's
  // customer or plan.
  await customerService.getCustomer(organizationId, input.customerId);
  const plan = await planService.getPlan(organizationId, input.planId);

  if (!plan.active) {
    throw ApiError.badRequest('Cannot subscribe to an inactive plan');
  }

  const now = new Date();
  const { trialDays } = input;
  const trialEnd = trialDays ? addInterval(now, 'DAY', trialDays) : null;
  const isTrial = trialEnd !== null;
  const currentPeriodEnd = trialEnd ?? addInterval(now, plan.interval as BillingInterval);

  return prisma.$transaction(async (tx) => {
    const subscription = await tx.subscription.create({
      data: {
        organizationId,
        customerId: input.customerId,
        planId: plan.id,
        status: isTrial ? 'TRIALING' : 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd,
        trialEnd,
      },
      include: WITH_RELATIONS,
    });

    await tx.subscriptionEvent.create({
      data: {
        subscriptionId: subscription.id,
        type: isTrial ? 'TRIAL_STARTED' : 'CREATED',
        newPlanId: plan.id,
      },
    });

    return subscription;
  });
}

export async function listSubscriptions(organizationId: string, query: ListSubscriptionsQuery) {
  return prisma.subscription.findMany({
    where: {
      organizationId,
      customerId: query.customerId,
      status: query.status,
    },
    include: WITH_RELATIONS,
    orderBy: { createdAt: 'desc' },
  });
}

// Scoping the lookup to organizationId means a subscription belonging to
// another org 404s exactly like one that doesn't exist, rather than leaking
// a 403 that would confirm the id is real.
export async function getSubscription(organizationId: string, subscriptionId: string) {
  const subscription = await prisma.subscription.findFirst({
    where: { id: subscriptionId, organizationId },
    include: WITH_RELATIONS,
  });

  if (!subscription) {
    throw ApiError.notFound('Subscription not found');
  }

  return subscription;
}

export async function cancelSubscription(
  organizationId: string,
  subscriptionId: string,
  input: CancelSubscriptionInput,
) {
  const subscription = await getSubscription(organizationId, subscriptionId);

  if (subscription.status === 'CANCELED') {
    throw ApiError.conflict('Subscription is already canceled');
  }

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const updated = await tx.subscription.update({
      where: { id: subscriptionId },
      data: input.atPeriodEnd
        ? { cancelAt: subscription.currentPeriodEnd }
        : { status: 'CANCELED', canceledAt: now, cancelAt: now },
      include: WITH_RELATIONS,
    });

    await tx.subscriptionEvent.create({
      data: {
        subscriptionId,
        type: input.atPeriodEnd ? 'CANCEL_SCHEDULED' : 'CANCELED',
      },
    });

    return updated;
  });
}

export interface ChangePlanResult {
  subscription: Awaited<ReturnType<typeof getSubscription>>;
  proration: ProrationResult;
}

// Switches a subscription to a different plan immediately (covers both
// upgrades and downgrades - the direction only affects the sign of the
// resulting proration). Proration is computed but not turned into an
// invoice or a payment here; Day 5's invoicing engine will read the
// PLAN_CHANGED SubscriptionEvent this writes to produce a line item.
export async function changeSubscriptionPlan(
  organizationId: string,
  subscriptionId: string,
  input: ChangeSubscriptionPlanInput,
): Promise<ChangePlanResult> {
  const subscription = await getSubscription(organizationId, subscriptionId);

  if (subscription.status === 'CANCELED') {
    throw ApiError.conflict('Cannot change the plan of a canceled subscription');
  }

  if (input.planId === subscription.planId) {
    throw ApiError.badRequest('Subscription is already on this plan');
  }

  const newPlan = await planService.getPlan(organizationId, input.planId);
  if (!newPlan.active) {
    throw ApiError.badRequest('Cannot switch to an inactive plan');
  }

  const now = new Date();
  const proration = calculateProration({
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
    changeAt: now,
    oldPeriodAmount: periodAmountForProration(subscription.plan),
    newPeriodAmount: periodAmountForProration(newPlan),
  });

  const updated = await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.update({
      where: { id: subscriptionId },
      data: { planId: newPlan.id },
      include: WITH_RELATIONS,
    });

    await tx.subscriptionEvent.create({
      data: {
        subscriptionId,
        type: 'PLAN_CHANGED',
        previousPlanId: subscription.planId,
        newPlanId: newPlan.id,
        prorationAmount: proration.netAmount,
      },
    });

    return sub;
  });

  return { subscription: updated, proration };
}

// Ends a TRIALING subscription's trial early and starts its first real
// billing period from now, rather than from the originally scheduled
// trialEnd.
export async function endTrial(organizationId: string, subscriptionId: string) {
  const subscription = await getSubscription(organizationId, subscriptionId);

  if (subscription.status !== 'TRIALING') {
    throw ApiError.badRequest('Subscription is not currently in a trial');
  }

  const now = new Date();
  const currentPeriodEnd = addInterval(now, subscription.plan.interval as BillingInterval);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd,
        trialEnd: now,
      },
      include: WITH_RELATIONS,
    });

    await tx.subscriptionEvent.create({
      data: { subscriptionId, type: 'TRIAL_ENDED' },
    });

    return updated;
  });
}
