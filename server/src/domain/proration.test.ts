import { describe, expect, it } from 'vitest';
import { calculateProration, periodAmountForProration } from './proration';

const periodStart = new Date('2026-01-01T00:00:00.000Z');
const periodEnd = new Date('2026-02-01T00:00:00.000Z'); // 31-day period

describe('calculateProration', () => {
  it('charges and credits the full amount when the change happens at period start', () => {
    const result = calculateProration({
      periodStart,
      periodEnd,
      changeAt: periodStart,
      oldPeriodAmount: 1000,
      newPeriodAmount: 2000,
    });

    expect(result.creditAmount).toBe(1000);
    expect(result.chargeAmount).toBe(2000);
    expect(result.netAmount).toBe(1000);
    expect(result.remainingFraction).toBe(1);
  });

  it('charges and credits nothing when the change happens at period end', () => {
    const result = calculateProration({
      periodStart,
      periodEnd,
      changeAt: periodEnd,
      oldPeriodAmount: 1000,
      newPeriodAmount: 2000,
    });

    expect(result.creditAmount).toBe(0);
    expect(result.chargeAmount).toBe(0);
    expect(result.netAmount).toBe(0);
    expect(result.remainingFraction).toBe(0);
  });

  it('prorates by the remaining fraction of the period at the midpoint', () => {
    const midpoint = new Date((periodStart.getTime() + periodEnd.getTime()) / 2);

    const result = calculateProration({
      periodStart,
      periodEnd,
      changeAt: midpoint,
      oldPeriodAmount: 3100,
      newPeriodAmount: 3100,
    });

    expect(result.remainingFraction).toBeCloseTo(0.5, 5);
    expect(result.creditAmount).toBe(1550);
    expect(result.chargeAmount).toBe(1550);
    expect(result.netAmount).toBe(0);
  });

  it('produces a positive netAmount (customer owes more) on an upgrade', () => {
    const midpoint = new Date((periodStart.getTime() + periodEnd.getTime()) / 2);

    const result = calculateProration({
      periodStart,
      periodEnd,
      changeAt: midpoint,
      oldPeriodAmount: 1000,
      newPeriodAmount: 5000,
    });

    expect(result.netAmount).toBeGreaterThan(0);
    expect(result.netAmount).toBe(result.chargeAmount - result.creditAmount);
  });

  it('produces a negative netAmount (customer is credited) on a downgrade', () => {
    const midpoint = new Date((periodStart.getTime() + periodEnd.getTime()) / 2);

    const result = calculateProration({
      periodStart,
      periodEnd,
      changeAt: midpoint,
      oldPeriodAmount: 5000,
      newPeriodAmount: 1000,
    });

    expect(result.netAmount).toBeLessThan(0);
  });

  it('clamps a changeAt before periodStart to the full remaining period', () => {
    const before = new Date('2025-12-15T00:00:00.000Z');

    const result = calculateProration({
      periodStart,
      periodEnd,
      changeAt: before,
      oldPeriodAmount: 1000,
      newPeriodAmount: 2000,
    });

    expect(result.remainingFraction).toBe(1);
    expect(result.creditAmount).toBe(1000);
  });

  it('clamps a changeAt after periodEnd to zero remaining period', () => {
    const after = new Date('2026-03-01T00:00:00.000Z');

    const result = calculateProration({
      periodStart,
      periodEnd,
      changeAt: after,
      oldPeriodAmount: 1000,
      newPeriodAmount: 2000,
    });

    expect(result.remainingFraction).toBe(0);
    expect(result.creditAmount).toBe(0);
  });

  it('rounds each amount independently rather than rounding the net', () => {
    // 10-day period, change 3 days in => remainingFraction = 7/10 = 0.7
    const start = new Date('2026-01-01T00:00:00.000Z');
    const end = new Date('2026-01-11T00:00:00.000Z');
    const changeAt = new Date('2026-01-04T00:00:00.000Z');

    const result = calculateProration({
      periodStart: start,
      periodEnd: end,
      changeAt,
      oldPeriodAmount: 999,
      newPeriodAmount: 333,
    });

    expect(result.creditAmount).toBe(Math.round(999 * 0.7));
    expect(result.chargeAmount).toBe(Math.round(333 * 0.7));
  });

  it('throws when periodEnd is not after periodStart', () => {
    expect(() =>
      calculateProration({
        periodStart: periodEnd,
        periodEnd: periodStart,
        changeAt: periodStart,
        oldPeriodAmount: 1000,
        newPeriodAmount: 1000,
      }),
    ).toThrow('periodEnd must be after periodStart');
  });

  it('handles a zero old amount (e.g. switching off a usage-only plan)', () => {
    const result = calculateProration({
      periodStart,
      periodEnd,
      changeAt: periodStart,
      oldPeriodAmount: 0,
      newPeriodAmount: 2000,
    });

    expect(result.creditAmount).toBe(0);
    expect(result.chargeAmount).toBe(2000);
    expect(result.netAmount).toBe(2000);
  });
});

describe('periodAmountForProration', () => {
  it('returns flatAmount for a FLAT plan', () => {
    expect(periodAmountForProration({ pricingModel: 'FLAT', flatAmount: 2900 })).toBe(2900);
  });

  it('returns 0 for a USAGE plan regardless of flatAmount', () => {
    expect(periodAmountForProration({ pricingModel: 'USAGE', flatAmount: null })).toBe(0);
  });

  it('returns 0 for a TIERED plan regardless of flatAmount', () => {
    expect(periodAmountForProration({ pricingModel: 'TIERED', flatAmount: null })).toBe(0);
  });

  it('returns 0 for a FLAT plan with a null flatAmount', () => {
    expect(periodAmountForProration({ pricingModel: 'FLAT', flatAmount: null })).toBe(0);
  });
});
