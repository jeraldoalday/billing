import type { Prisma } from '@prisma/client';
import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import {
  couponMatchesCurrency,
  couponUnavailableReason,
  redemptionStatusAfterPeriod,
  type CouponUnavailableReason,
} from '../domain/coupon';
import * as subscriptionService from './subscription.service';
import type {
  CreateCouponInput,
  ListCouponsQuery,
  ListRedemptionsQuery,
  RedeemCouponInput,
  UpdateCouponInput,
} from '../validators/coupon';

// Coupons and the redemptions that attach them to subscriptions. The rules
// about what a coupon is worth and how long it lasts all live in
// src/domain/coupon.ts; this service owns storage, org-scoping, and the
// invariants that need the database to check (unique codes, one active
// redemption per subscription).

const WITH_COUPON = { coupon: true } as const;

export async function createCoupon(organizationId: string, input: CreateCouponInput) {
  await assertCodeAvailable(organizationId, input.code);

  return prisma.coupon.create({
    data: {
      organizationId,
      code: input.code,
      name: input.name,
      type: input.type,
      // The validator has already rejected the mismatched combinations, so
      // only the field belonging to this coupon type can be set here.
      percentOff: input.type === 'PERCENT_OFF' ? input.percentOff : null,
      amountOff: input.type === 'AMOUNT_OFF' ? input.amountOff : null,
      currency: input.type === 'AMOUNT_OFF' ? input.currency : null,
      duration: input.duration,
      durationInMonths: input.duration === 'REPEATING' ? input.durationInMonths : null,
      maxRedemptions: input.maxRedemptions,
      redeemBy: input.redeemBy,
      active: input.active ?? true,
    },
  });
}

async function assertCodeAvailable(organizationId: string, code: string) {
  const existing = await prisma.coupon.findUnique({
    where: { organizationId_code: { organizationId, code } },
  });
  if (existing) {
    throw ApiError.conflict('A coupon with this code already exists');
  }
}

export async function listCoupons(organizationId: string, query: ListCouponsQuery) {
  return prisma.coupon.findMany({
    where: {
      organizationId,
      active: query.active,
      code: query.code,
      duration: query.duration,
    },
    orderBy: { createdAt: 'desc' },
  });
}

// Scoping the lookup to organizationId means a coupon belonging to another
// org 404s exactly like one that doesn't exist, rather than leaking a 403
// that would confirm the id is real.
export async function getCoupon(organizationId: string, couponId: string) {
  const coupon = await prisma.coupon.findFirst({
    where: { id: couponId, organizationId },
  });

  if (!coupon) {
    throw ApiError.notFound('Coupon not found');
  }

  return coupon;
}

export async function getCouponByCode(organizationId: string, code: string) {
  const coupon = await prisma.coupon.findUnique({
    where: { organizationId_code: { organizationId, code } },
  });

  if (!coupon) {
    throw ApiError.notFound('Coupon not found');
  }

  return coupon;
}

export async function updateCoupon(organizationId: string, couponId: string, input: UpdateCouponInput) {
  await getCoupon(organizationId, couponId);

  return prisma.coupon.update({
    where: { id: couponId },
    data: {
      name: input.name,
      maxRedemptions: input.maxRedemptions,
      redeemBy: input.redeemBy,
      active: input.active,
    },
  });
}

// Refuses to delete a coupon anyone has ever redeemed: its redemptions are
// what past invoices' discounts were derived from, and cascading them away
// would leave those invoices unexplainable. Retiring an offer that's in use
// is what `active: false` is for — it blocks new redemptions and leaves
// existing ones running.
export async function deleteCoupon(organizationId: string, couponId: string): Promise<void> {
  await getCoupon(organizationId, couponId);

  const redemptionCount = await prisma.couponRedemption.count({ where: { couponId } });
  if (redemptionCount > 0) {
    throw ApiError.conflict('Cannot delete a coupon that has been redeemed; deactivate it instead');
  }

  await prisma.coupon.delete({ where: { id: couponId } });
}

const UNAVAILABLE_MESSAGES: Record<CouponUnavailableReason, string> = {
  INACTIVE: 'This coupon is no longer active',
  EXPIRED: 'This coupon has expired',
  MAX_REDEMPTIONS_REACHED: 'This coupon has reached its redemption limit',
};

// Attaches a coupon to a subscription. The redemption — not the coupon — is
// what src/services/invoice.service.ts reads at generation time, so
// everything that could make the discount inapplicable is checked here,
// once, rather than on every invoice: the offer is still open, the
// subscription is still billable, its currency matches an amount-off
// coupon's, and nothing else is already discounting it.
export async function redeemCoupon(
  organizationId: string,
  subscriptionId: string,
  input: RedeemCouponInput,
) {
  // 404s if the subscription belongs to another org, which also keeps a
  // redemption from ever pointing at another org's subscription.
  const subscription = await subscriptionService.getSubscription(organizationId, subscriptionId);

  if (subscription.status === 'CANCELED') {
    throw ApiError.badRequest('Cannot apply a coupon to a canceled subscription');
  }

  const coupon = await getCouponByCode(organizationId, input.code);

  const unavailable = couponUnavailableReason(coupon);
  if (unavailable) {
    throw ApiError.conflict(UNAVAILABLE_MESSAGES[unavailable]);
  }

  if (!couponMatchesCurrency(coupon, subscription.plan.currency)) {
    throw ApiError.badRequest(
      `This coupon is denominated in ${coupon.currency?.toUpperCase()} and cannot be applied to a ${subscription.plan.currency.toUpperCase()} subscription`,
    );
  }

  const active = await getActiveRedemption(organizationId, subscriptionId);
  if (active) {
    throw ApiError.conflict('This subscription already has an active coupon');
  }

  // The redemption counter and the redemption row move together: counting a
  // redemption that failed to be written (or writing one that wasn't
  // counted) would let a capped coupon be over- or under-redeemed.
  return prisma.$transaction(async (tx) => {
    await tx.coupon.update({
      where: { id: coupon.id },
      data: { timesRedeemed: { increment: 1 } },
    });

    return tx.couponRedemption.create({
      data: {
        organizationId,
        couponId: coupon.id,
        subscriptionId,
        status: 'ACTIVE',
      },
      include: WITH_COUPON,
    });
  });
}

// The redemption currently discounting a subscription's invoices, if any.
// Also the read behind GET /subscriptions/:id/coupon, so a caller can see
// what they're being charged before the invoice exists.
export async function getActiveRedemption(organizationId: string, subscriptionId: string) {
  return prisma.couponRedemption.findFirst({
    where: { organizationId, subscriptionId, status: 'ACTIVE' },
    include: WITH_COUPON,
    orderBy: { createdAt: 'desc' },
  });
}

export async function listRedemptions(organizationId: string, query: ListRedemptionsQuery) {
  return prisma.couponRedemption.findMany({
    where: {
      organizationId,
      status: query.status,
      couponId: query.couponId,
      subscriptionId: query.subscriptionId,
    },
    include: WITH_COUPON,
    orderBy: { createdAt: 'desc' },
  });
}

// Detaches whatever coupon is discounting a subscription. REMOVED rather
// than deleted, so an invoice generated while it was active still has the
// redemption it was derived from on file. Note that Coupon.timesRedeemed is
// deliberately not decremented (see prisma/schema.prisma): the cap is on
// how many customers may take an offer up, not how many hold it now.
export async function removeRedemption(organizationId: string, subscriptionId: string) {
  await subscriptionService.getSubscription(organizationId, subscriptionId);

  const redemption = await getActiveRedemption(organizationId, subscriptionId);
  if (!redemption) {
    throw ApiError.notFound('This subscription has no active coupon');
  }

  return prisma.couponRedemption.update({
    where: { id: redemption.id },
    data: { status: 'REMOVED', endedAt: new Date() },
    include: WITH_COUPON,
  });
}

// Records that a redemption discounted one more invoice, completing it once
// its duration is spent. Takes the transaction client so this happens in
// the same transaction that writes the invoice — a discount that was
// applied but not counted would keep applying forever.
export async function consumeRedemptionPeriod(
  tx: Prisma.TransactionClient,
  redemption: { id: string; periodsApplied: number; coupon: { duration: string; durationInMonths: number | null } },
): Promise<void> {
  const periodsApplied = redemption.periodsApplied + 1;
  const status = redemptionStatusAfterPeriod(redemption.coupon, periodsApplied);

  await tx.couponRedemption.update({
    where: { id: redemption.id },
    data: {
      periodsApplied,
      status,
      endedAt: status === 'COMPLETED' ? new Date() : null,
    },
  });
}
