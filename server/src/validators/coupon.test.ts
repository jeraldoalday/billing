import { describe, expect, it } from 'vitest';
import { createCouponSchema, updateCouponSchema } from './coupon';

describe('createCouponSchema', () => {
  it('parses a valid PERCENT_OFF coupon and uppercases the code', () => {
    const result = createCouponSchema.parse({
      code: 'save20',
      type: 'PERCENT_OFF',
      percentOff: 20,
      duration: 'ONCE',
    });

    expect(result.code).toBe('SAVE20');
    expect(result.percentOff).toBe(20);
  });

  it('parses a valid AMOUNT_OFF coupon', () => {
    const result = createCouponSchema.parse({
      code: 'FLAT500',
      type: 'AMOUNT_OFF',
      amountOff: 500,
      currency: 'USD',
      duration: 'FOREVER',
    });

    expect(result.amountOff).toBe(500);
    expect(result.currency).toBe('usd');
  });

  it('rejects a PERCENT_OFF coupon missing percentOff', () => {
    const result = createCouponSchema.safeParse({
      code: 'SAVE20',
      type: 'PERCENT_OFF',
      duration: 'ONCE',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a PERCENT_OFF coupon that also carries amountOff', () => {
    const result = createCouponSchema.safeParse({
      code: 'SAVE20',
      type: 'PERCENT_OFF',
      percentOff: 20,
      amountOff: 500,
      duration: 'ONCE',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an AMOUNT_OFF coupon missing currency', () => {
    const result = createCouponSchema.safeParse({
      code: 'FLAT500',
      type: 'AMOUNT_OFF',
      amountOff: 500,
      duration: 'ONCE',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an AMOUNT_OFF coupon that also carries percentOff', () => {
    const result = createCouponSchema.safeParse({
      code: 'FLAT500',
      type: 'AMOUNT_OFF',
      amountOff: 500,
      currency: 'usd',
      percentOff: 10,
      duration: 'ONCE',
    });
    expect(result.success).toBe(false);
  });

  it('requires durationInMonths for a REPEATING coupon', () => {
    const result = createCouponSchema.safeParse({
      code: 'SAVE20',
      type: 'PERCENT_OFF',
      percentOff: 20,
      duration: 'REPEATING',
    });
    expect(result.success).toBe(false);
  });

  it('rejects durationInMonths on a non-REPEATING coupon', () => {
    const result = createCouponSchema.safeParse({
      code: 'SAVE20',
      type: 'PERCENT_OFF',
      percentOff: 20,
      duration: 'ONCE',
      durationInMonths: 3,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a REPEATING coupon with durationInMonths set', () => {
    const result = createCouponSchema.safeParse({
      code: 'SAVE20',
      type: 'PERCENT_OFF',
      percentOff: 20,
      duration: 'REPEATING',
      durationInMonths: 6,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a code with characters outside the allowed set', () => {
    const result = createCouponSchema.safeParse({
      code: 'SAVE 20%',
      type: 'PERCENT_OFF',
      percentOff: 20,
      duration: 'ONCE',
    });
    expect(result.success).toBe(false);
  });
});

describe('updateCouponSchema', () => {
  it('accepts changing only active', () => {
    const result = updateCouponSchema.safeParse({ active: false });
    expect(result.success).toBe(true);
  });

  it('rejects an empty update', () => {
    const result = updateCouponSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('has no way to change the discount itself', () => {
    // percentOff/amountOff/type/duration are deliberately absent from the
    // schema's shape — an attempt to set them is simply stripped rather
    // than rejected, since Zod ignores unknown keys by default.
    const result = updateCouponSchema.parse({ active: true, percentOff: 50 });
    expect(result).not.toHaveProperty('percentOff');
  });
});
