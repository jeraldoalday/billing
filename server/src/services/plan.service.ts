import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import * as productService from './product.service';
import type { CreatePlanInput, ListPlansQuery, UpdatePlanInput } from '../validators/plan';

export const TIERS_ORDERED = { tiers: { orderBy: { order: 'asc' as const } } };

export async function createPlan(organizationId: string, input: CreatePlanInput) {
  // Throws a 404 if the product doesn't exist or belongs to another org,
  // which also keeps a plan from ever pointing at another org's product.
  await productService.getProduct(organizationId, input.productId);

  return prisma.plan.create({
    data: {
      organizationId,
      productId: input.productId,
      name: input.name,
      pricingModel: input.pricingModel,
      interval: input.interval,
      currency: input.currency,
      active: input.active ?? true,
      flatAmount: input.pricingModel === 'FLAT' ? input.flatAmount : undefined,
      usageMetric: input.pricingModel !== 'FLAT' ? input.usageMetric : undefined,
      usageUnitAmount: input.pricingModel === 'USAGE' ? input.usageUnitAmount : undefined,
      tiers:
        input.pricingModel === 'TIERED'
          ? {
              create: input.tiers.map((tier, order) => ({
                order,
                upTo: tier.upTo,
                unitAmount: tier.unitAmount,
                flatFee: tier.flatFee,
              })),
            }
          : undefined,
    },
    include: TIERS_ORDERED,
  });
}

export async function listPlans(organizationId: string, query: ListPlansQuery) {
  return prisma.plan.findMany({
    where: {
      organizationId,
      productId: query.productId,
      active: query.active,
    },
    include: TIERS_ORDERED,
    orderBy: { createdAt: 'desc' },
  });
}

// Scoping the lookup to organizationId means a plan belonging to another org
// 404s exactly like one that doesn't exist, rather than leaking a 403 that
// would confirm the id is real.
export async function getPlan(organizationId: string, planId: string) {
  const plan = await prisma.plan.findFirst({
    where: { id: planId, organizationId },
    include: TIERS_ORDERED,
  });

  if (!plan) {
    throw ApiError.notFound('Plan not found');
  }

  return plan;
}

export async function updatePlan(organizationId: string, planId: string, input: UpdatePlanInput) {
  await getPlan(organizationId, planId);

  return prisma.plan.update({
    where: { id: planId },
    data: {
      name: input.name,
      active: input.active,
    },
    include: TIERS_ORDERED,
  });
}

// Refuses to delete a plan that any subscription (active or historical)
// still references. Subscriptions store their pricing by reference to the
// plan rather than copying it, so deleting a referenced plan would corrupt
// both live billing and historical records.
export async function deletePlan(organizationId: string, planId: string): Promise<void> {
  await getPlan(organizationId, planId);

  const subscriptionCount = await prisma.subscription.count({ where: { planId } });
  if (subscriptionCount > 0) {
    throw ApiError.conflict('Cannot delete a plan that has subscriptions');
  }

  await prisma.plan.delete({ where: { id: planId } });
}
