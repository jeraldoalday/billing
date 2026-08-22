// Pure discount math for coupons. No I/O and no Prisma types — takes plain
// values so the rules a discount lives by (is this coupon still on offer,
// does this redemption still apply to this period, how much comes off this
// subtotal) are independently testable from the service that stores them.
// Amounts are integer minor currency units (e.g. cents), like everywhere
// else in this codebase.

// SQLite has no native enum type (see prisma/schema.prisma), so Coupon's
// `type`/`duration` and CouponRedemption's `status` columns are plain
// strings. These tuples are the single source of truth for the valid
// values, consumed by Zod schemas (z.enum) and anywhere else that needs the
// allowed set at runtime.

export const COUPON_TYPES = ['PERCENT_OFF', 'AMOUNT_OFF'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

// How many billing periods one redemption keeps discounting for: a single
// invoice (ONCE), a fixed run of them (REPEATING, sized by
// `durationInMonths`), or every invoice until the coupon is detached or the
// subscription ends (FOREVER).
export const COUPON_DURATIONS = ['ONCE', 'REPEATING', 'FOREVER'] as const;
export type CouponDuration = (typeof COUPON_DURATIONS)[number];

export const COUPON_REDEMPTION_STATUSES = ['ACTIVE', 'COMPLETED', 'REMOVED'] as const;
export type CouponRedemptionStatus = (typeof COUPON_REDEMPTION_STATUSES)[number];

// Why a coupon can't be redeemed right now. `null` from
// couponUnavailableReason means it can. Kept as a small closed set (rather
// than a message string) so the service can turn each one into its own
// response and the caller can branch on it.
export const COUPON_UNAVAILABLE_REASONS = ['INACTIVE', 'EXPIRED', 'MAX_REDEMPTIONS_REACHED'] as const;
export type CouponUnavailableReason = (typeof COUPON_UNAVAILABLE_REASONS)[number];

export interface RedeemableCoupon {
  active: boolean;
  redeemBy: Date | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
}

// Whether a coupon is still on offer at `asOf`. `redeemBy` is the last
// instant the offer stands, so a redemption made exactly at that timestamp
// is still honoured — the boundary belongs to the customer, not to us.
export function couponUnavailableReason(
  coupon: RedeemableCoupon,
  asOf: Date = new Date(),
): CouponUnavailableReason | null {
  if (!coupon.active) {
    return 'INACTIVE';
  }
  if (coupon.redeemBy && coupon.redeemBy.getTime() < asOf.getTime()) {
    return 'EXPIRED';
  }
  if (coupon.maxRedemptions !== null && coupon.timesRedeemed >= coupon.maxRedemptions) {
    return 'MAX_REDEMPTIONS_REACHED';
  }
  return null;
}

export interface DiscountableCoupon {
  type: string;
  percentOff: number | null;
  amountOff: number | null;
}

// What comes off a subtotal, as a positive amount. Never exceeds the
// subtotal (a $50 coupon against a $20 invoice takes $20 off, it doesn't
// hand back $30) and never applies to a subtotal that is already zero or
// negative — an invoice made entirely of proration credits is money we owe
// the customer, and discounting it further would be discounting a refund.
export function calculateDiscountAmount(coupon: DiscountableCoupon, subtotal: number): number {
  if (subtotal <= 0) {
    return 0;
  }

  const raw =
    coupon.type === 'PERCENT_OFF'
      ? Math.round((subtotal * (coupon.percentOff ?? 0)) / 100)
      : (coupon.amountOff ?? 0);

  return Math.max(0, Math.min(raw, subtotal));
}

export interface DurationBoundCoupon {
  duration: string;
  durationInMonths: number | null;
}

// Whether a redemption that has already discounted `periodsApplied`
// invoices still discounts the next one. REPEATING with no
// `durationInMonths` on file would otherwise run forever; it's rejected at
// validation time (see src/validators/coupon.ts), and treated as spent here
// rather than as infinite, so a bad row can't quietly give away revenue.
export function couponAppliesToPeriod(coupon: DurationBoundCoupon, periodsApplied: number): boolean {
  switch (coupon.duration) {
    case 'ONCE':
      return periodsApplied < 1;
    case 'REPEATING':
      return periodsApplied < (coupon.durationInMonths ?? 0);
    case 'FOREVER':
      return true;
    default:
      return false;
  }
}

// The status a redemption lands in once it has discounted one more period.
// Spending the last period of a ONCE/REPEATING coupon completes the
// redemption immediately, rather than leaving it ACTIVE until the next
// invoice generation discovers there's nothing left — so what the API
// reports and what the next invoice will do never disagree.
export function redemptionStatusAfterPeriod(
  coupon: DurationBoundCoupon,
  periodsApplied: number,
): CouponRedemptionStatus {
  return couponAppliesToPeriod(coupon, periodsApplied) ? 'ACTIVE' : 'COMPLETED';
}

// An AMOUNT_OFF coupon is denominated in a currency, so it can only come off
// an invoice billed in that same currency — taking 500 "usd" off a
// eur-denominated invoice would silently invent an exchange rate. A
// PERCENT_OFF coupon is currency-free and applies to any invoice, and a
// coupon with no currency on file is treated as unrestricted.
export function couponMatchesCurrency(
  coupon: { type: string; currency: string | null },
  currency: string,
): boolean {
  if (coupon.type !== 'AMOUNT_OFF' || !coupon.currency) {
    return true;
  }
  return coupon.currency.toLowerCase() === currency.toLowerCase();
}

// Human-readable summary of what a coupon takes off, for invoice line item
// descriptions and API responses. Amount-off coupons render in major units
// (the minor-unit integer divided by 100) since that's how a customer reads
// a price; the underlying math never leaves integer minor units.
export function describeCoupon(coupon: {
  type: string;
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
}): string {
  if (coupon.type === 'PERCENT_OFF') {
    return `${coupon.percentOff ?? 0}% off`;
  }
  const major = ((coupon.amountOff ?? 0) / 100).toFixed(2);
  return `${major} ${(coupon.currency ?? '').toUpperCase()} off`.trim();
}
