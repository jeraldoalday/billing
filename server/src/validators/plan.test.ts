import { describe, expect, it } from 'vitest';
import { createPlanSchema, validateTierOrdering } from './plan';

const productId = 'clx0000000000000000000000';

describe('validateTierOrdering', () => {
  it('accepts a single unbounded tier', () => {
    expect(validateTierOrdering([{ upTo: null, unitAmount: 10, flatFee: 0 }])).toBeNull();
  });

  it('accepts strictly increasing bounded tiers ending in an unbounded tier', () => {
    const result = validateTierOrdering([
      { upTo: 100, unitAmount: 10, flatFee: 0 },
      { upTo: 500, unitAmount: 8, flatFee: 0 },
      { upTo: null, unitAmount: 5, flatFee: 0 },
    ]);
    expect(result).toBeNull();
  });

  it('accepts all-bounded tiers with no unbounded tail', () => {
    const result = validateTierOrdering([
      { upTo: 100, unitAmount: 10, flatFee: 0 },
      { upTo: 200, unitAmount: 8, flatFee: 0 },
    ]);
    expect(result).toBeNull();
  });

  it('rejects an empty tier list', () => {
    expect(validateTierOrdering([])).toMatch(/at least one tier/i);
  });

  it('rejects a non-final unbounded tier', () => {
    const result = validateTierOrdering([
      { upTo: null, unitAmount: 10, flatFee: 0 },
      { upTo: 100, unitAmount: 8, flatFee: 0 },
    ]);
    expect(result).toMatch(/unbounded/i);
  });

  it('rejects tiers that do not strictly increase', () => {
    const result = validateTierOrdering([
      { upTo: 100, unitAmount: 10, flatFee: 0 },
      { upTo: 100, unitAmount: 8, flatFee: 0 },
    ]);
    expect(result).toMatch(/must be greater than/i);
  });

  it('rejects tiers given out of order', () => {
    const result = validateTierOrdering([
      { upTo: 500, unitAmount: 8, flatFee: 0 },
      { upTo: 100, unitAmount: 10, flatFee: 0 },
    ]);
    expect(result).toMatch(/must be greater than/i);
  });
});

describe('createPlanSchema', () => {
  it('parses a valid flat plan and defaults currency', () => {
    const result = createPlanSchema.parse({
      productId,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      flatAmount: 2900,
    });

    expect(result.currency).toBe('usd');
    if (result.pricingModel !== 'FLAT') throw new Error('expected FLAT');
    expect(result.flatAmount).toBe(2900);
  });

  it('rejects a flat plan missing flatAmount', () => {
    expect(() =>
      createPlanSchema.parse({
        productId,
        name: 'Pro Monthly',
        pricingModel: 'FLAT',
        interval: 'MONTH',
      }),
    ).toThrow();
  });

  it('parses a valid usage plan', () => {
    const result = createPlanSchema.parse({
      productId,
      name: 'API Calls',
      pricingModel: 'USAGE',
      interval: 'MONTH',
      usageMetric: 'api_calls',
      usageUnitAmount: 2,
    });

    if (result.pricingModel !== 'USAGE') throw new Error('expected USAGE');
    expect(result.usageMetric).toBe('api_calls');
  });

  it('rejects a usage plan missing usageMetric', () => {
    expect(() =>
      createPlanSchema.parse({
        productId,
        name: 'API Calls',
        pricingModel: 'USAGE',
        interval: 'MONTH',
        usageUnitAmount: 2,
      }),
    ).toThrow();
  });

  it('parses a valid tiered plan', () => {
    const result = createPlanSchema.parse({
      productId,
      name: 'Storage',
      pricingModel: 'TIERED',
      interval: 'MONTH',
      usageMetric: 'gb_stored',
      tiers: [
        { upTo: 100, unitAmount: 10 },
        { upTo: null, unitAmount: 5 },
      ],
    });

    if (result.pricingModel !== 'TIERED') throw new Error('expected TIERED');
    expect(result.tiers).toHaveLength(2);
    expect(result.tiers[1]?.flatFee).toBe(0);
  });

  it('rejects a tiered plan with badly ordered tiers', () => {
    expect(() =>
      createPlanSchema.parse({
        productId,
        name: 'Storage',
        pricingModel: 'TIERED',
        interval: 'MONTH',
        usageMetric: 'gb_stored',
        tiers: [
          { upTo: 100, unitAmount: 10 },
          { upTo: 50, unitAmount: 5 },
        ],
      }),
    ).toThrow();
  });

  it('rejects a tiered plan with an empty tiers array', () => {
    expect(() =>
      createPlanSchema.parse({
        productId,
        name: 'Storage',
        pricingModel: 'TIERED',
        interval: 'MONTH',
        usageMetric: 'gb_stored',
        tiers: [],
      }),
    ).toThrow();
  });

  it('rejects an unknown pricingModel', () => {
    expect(() =>
      createPlanSchema.parse({
        productId,
        name: 'Mystery',
        pricingModel: 'SUBSCRIPTION_BOX',
        interval: 'MONTH',
        flatAmount: 100,
      }),
    ).toThrow();
  });

  it('rejects an unknown interval', () => {
    expect(() =>
      createPlanSchema.parse({
        productId,
        name: 'Pro Monthly',
        pricingModel: 'FLAT',
        interval: 'FORTNIGHT',
        flatAmount: 100,
      }),
    ).toThrow();
  });
});
