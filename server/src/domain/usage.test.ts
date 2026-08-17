import { describe, expect, it } from 'vitest';
import { calculateTieredAmount, calculateUsageAmount, type UsageTier } from './usage';

const TIERS: UsageTier[] = [
  { order: 0, upTo: 100, unitAmount: 10, flatFee: 0 },
  { order: 1, upTo: 500, unitAmount: 8, flatFee: 0 },
  { order: 2, upTo: null, unitAmount: 5, flatFee: 0 },
];

describe('calculateTieredAmount', () => {
  it('returns 0 for zero quantity', () => {
    expect(calculateTieredAmount(0, TIERS)).toBe(0);
  });

  it('returns 0 for negative quantity', () => {
    expect(calculateTieredAmount(-5, TIERS)).toBe(0);
  });

  it('bills entirely within the first tier when usage stays under its cap', () => {
    expect(calculateTieredAmount(50, TIERS)).toBe(50 * 10);
  });

  it('bills exactly up to a tier boundary within that tier', () => {
    expect(calculateTieredAmount(100, TIERS)).toBe(100 * 10);
  });

  it('spills one unit past a boundary into the next tier', () => {
    // 100 units @ 10 + 1 unit @ 8
    expect(calculateTieredAmount(101, TIERS)).toBe(100 * 10 + 1 * 8);
  });

  it('bills cumulatively across three tiers', () => {
    // 100 @ 10 + 400 @ 8 + 50 @ 5
    expect(calculateTieredAmount(550, TIERS)).toBe(100 * 10 + 400 * 8 + 50 * 5);
  });

  it('bills entirely within the unbounded final tier once earlier tiers are exhausted', () => {
    const amount = calculateTieredAmount(1000, TIERS);
    expect(amount).toBe(100 * 10 + 400 * 8 + 500 * 5);
  });

  it('adds a flat fee once per tier that has any quantity billed within it', () => {
    const tiersWithFees: UsageTier[] = [
      { order: 0, upTo: 100, unitAmount: 10, flatFee: 500 },
      { order: 1, upTo: null, unitAmount: 5, flatFee: 200 },
    ];

    // Tier 0 fully consumed (100 @ 10 + 500 flat), tier 1 gets 20 units (20 @ 5 + 200 flat)
    expect(calculateTieredAmount(120, tiersWithFees)).toBe(100 * 10 + 500 + 20 * 5 + 200);
  });

  it('does not charge a later tier flat fee when usage never reaches it', () => {
    const tiersWithFees: UsageTier[] = [
      { order: 0, upTo: 100, unitAmount: 10, flatFee: 500 },
      { order: 1, upTo: null, unitAmount: 5, flatFee: 200 },
    ];

    // Only tier 0 has any quantity billed within it, so only its flat fee applies.
    expect(calculateTieredAmount(50, tiersWithFees)).toBe(50 * 10 + 500);
  });

  it('sorts tiers by order before billing, regardless of input order', () => {
    const shuffled = [TIERS[2], TIERS[0], TIERS[1]] as UsageTier[];
    expect(calculateTieredAmount(550, shuffled)).toBe(calculateTieredAmount(550, TIERS));
  });

  it('throws when no tiers are given for a positive quantity', () => {
    expect(() => calculateTieredAmount(10, [])).toThrow();
  });
});

describe('calculateUsageAmount', () => {
  it('multiplies quantity by the per-unit amount for a USAGE plan', () => {
    const amount = calculateUsageAmount({ pricingModel: 'USAGE', usageUnitAmount: 3 }, [], 250);
    expect(amount).toBe(750);
  });

  it('returns 0 for a USAGE plan with zero quantity', () => {
    const amount = calculateUsageAmount({ pricingModel: 'USAGE', usageUnitAmount: 3 }, [], 0);
    expect(amount).toBe(0);
  });

  it('delegates to graduated tiering for a TIERED plan', () => {
    const amount = calculateUsageAmount(
      { pricingModel: 'TIERED', usageUnitAmount: null },
      TIERS,
      101,
    );
    expect(amount).toBe(100 * 10 + 1 * 8);
  });

  it('throws for a FLAT plan, which has no usage component', () => {
    expect(() =>
      calculateUsageAmount({ pricingModel: 'FLAT', usageUnitAmount: null }, [], 10),
    ).toThrow();
  });
});
