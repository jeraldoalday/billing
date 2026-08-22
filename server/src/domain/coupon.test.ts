import { describe, expect, it } from 'vitest';
import {
  calculateDiscountAmount,
  couponAppliesToPeriod,
  couponMatchesCurrency,
  couponUnavailableReason,
  describeCoupon,
  redemptionStatusAfterPeriod,
} from './coupon';

const redeemable = {
  active: true,
  redeemBy: null,
  maxRedemptions: null,
  timesRedeemed: 0,
};

describe('couponUnavailableReason', () => {
  it('returns null for a coupon that is still on offer', () => {
    expect(couponUnavailableReason(redeemable)).toBeNull();
  });

  it('reports a deactivated coupon', () => {
    expect(couponUnavailableReason({ ...redeemable, active: false })).toBe('INACTIVE');
  });

  it('reports a coupon whose redeemBy has passed', () => {
    const coupon = { ...redeemable, redeemBy: new Date('2026-01-01T00:00:00Z') };

    expect(couponUnavailableReason(coupon, new Date('2026-01-02T00:00:00Z'))).toBe('EXPIRED');
  });

  it('still honours a redemption made exactly at redeemBy', () => {
    const redeemBy = new Date('2026-01-01T00:00:00Z');

    expect(couponUnavailableReason({ ...redeemable, redeemBy }, redeemBy)).toBeNull();
  });

  it('reports a coupon that has hit its redemption cap', () => {
    const coupon = { ...redeemable, maxRedemptions: 2, timesRedeemed: 2 };

    expect(couponUnavailableReason(coupon)).toBe('MAX_REDEMPTIONS_REACHED');
  });

  it('allows a coupon that is still under its redemption cap', () => {
    const coupon = { ...redeemable, maxRedemptions: 2, timesRedeemed: 1 };

    expect(couponUnavailableReason(coupon)).toBeNull();
  });

  it('reports inactivity ahead of expiry when both apply', () => {
    const coupon = { ...redeemable, active: false, redeemBy: new Date('2026-01-01T00:00:00Z') };

    expect(couponUnavailableReason(coupon, new Date('2026-06-01T00:00:00Z'))).toBe('INACTIVE');
  });
});

describe('calculateDiscountAmount', () => {
  const percentOff = { type: 'PERCENT_OFF', percentOff: 25, amountOff: null };
  const amountOff = { type: 'AMOUNT_OFF', percentOff: null, amountOff: 1500 };

  it('takes a percentage off the subtotal', () => {
    expect(calculateDiscountAmount(percentOff, 10000)).toBe(2500);
  });

  it('rounds a percentage to the nearest whole minor currency unit', () => {
    // 25% of 333 = 83.25, rounds to 83.
    expect(calculateDiscountAmount(percentOff, 333)).toBe(83);
  });

  it('takes a fixed amount off the subtotal', () => {
    expect(calculateDiscountAmount(amountOff, 10000)).toBe(1500);
  });

  it('never discounts more than the subtotal', () => {
    expect(calculateDiscountAmount(amountOff, 900)).toBe(900);
  });

  it('discounts a 100% coupon down to exactly zero', () => {
    const free = { type: 'PERCENT_OFF', percentOff: 100, amountOff: null };

    expect(calculateDiscountAmount(free, 4999)).toBe(4999);
  });

  it('leaves a zero or negative subtotal alone', () => {
    expect(calculateDiscountAmount(percentOff, 0)).toBe(0);
    expect(calculateDiscountAmount(amountOff, -2500)).toBe(0);
  });
});

describe('couponAppliesToPeriod', () => {
  it('applies a ONCE coupon to the first period only', () => {
    const once = { duration: 'ONCE', durationInMonths: null };

    expect(couponAppliesToPeriod(once, 0)).toBe(true);
    expect(couponAppliesToPeriod(once, 1)).toBe(false);
  });

  it('applies a REPEATING coupon for its full run of periods', () => {
    const repeating = { duration: 'REPEATING', durationInMonths: 3 };

    expect(couponAppliesToPeriod(repeating, 0)).toBe(true);
    expect(couponAppliesToPeriod(repeating, 2)).toBe(true);
    expect(couponAppliesToPeriod(repeating, 3)).toBe(false);
  });

  it('treats a REPEATING coupon with no month count as spent', () => {
    expect(couponAppliesToPeriod({ duration: 'REPEATING', durationInMonths: null }, 0)).toBe(false);
  });

  it('applies a FOREVER coupon to every period', () => {
    const forever = { duration: 'FOREVER', durationInMonths: null };

    expect(couponAppliesToPeriod(forever, 0)).toBe(true);
    expect(couponAppliesToPeriod(forever, 120)).toBe(true);
  });

  it('treats an unrecognized duration as spent', () => {
    expect(couponAppliesToPeriod({ duration: 'WEEKLY', durationInMonths: 5 }, 0)).toBe(false);
  });
});

describe('redemptionStatusAfterPeriod', () => {
  it('completes a ONCE redemption as soon as it has been used', () => {
    expect(redemptionStatusAfterPeriod({ duration: 'ONCE', durationInMonths: null }, 1)).toBe('COMPLETED');
  });

  it('keeps a REPEATING redemption active until its last period is spent', () => {
    const repeating = { duration: 'REPEATING', durationInMonths: 2 };

    expect(redemptionStatusAfterPeriod(repeating, 1)).toBe('ACTIVE');
    expect(redemptionStatusAfterPeriod(repeating, 2)).toBe('COMPLETED');
  });

  it('never completes a FOREVER redemption', () => {
    expect(redemptionStatusAfterPeriod({ duration: 'FOREVER', durationInMonths: null }, 99)).toBe('ACTIVE');
  });
});

describe('couponMatchesCurrency', () => {
  it('matches an amount-off coupon only against its own currency', () => {
    const coupon = { type: 'AMOUNT_OFF', currency: 'usd' };

    expect(couponMatchesCurrency(coupon, 'usd')).toBe(true);
    expect(couponMatchesCurrency(coupon, 'USD')).toBe(true);
    expect(couponMatchesCurrency(coupon, 'eur')).toBe(false);
  });

  it('applies a percent-off coupon to any currency', () => {
    expect(couponMatchesCurrency({ type: 'PERCENT_OFF', currency: null }, 'eur')).toBe(true);
  });

  it('treats an amount-off coupon with no currency on file as unrestricted', () => {
    expect(couponMatchesCurrency({ type: 'AMOUNT_OFF', currency: null }, 'eur')).toBe(true);
  });
});

describe('describeCoupon', () => {
  it('describes a percent-off coupon', () => {
    expect(describeCoupon({ type: 'PERCENT_OFF', percentOff: 20, amountOff: null, currency: null })).toBe('20% off');
  });

  it('describes an amount-off coupon in major currency units', () => {
    expect(describeCoupon({ type: 'AMOUNT_OFF', percentOff: null, amountOff: 1500, currency: 'usd' })).toBe(
      '15.00 USD off',
    );
  });
});
