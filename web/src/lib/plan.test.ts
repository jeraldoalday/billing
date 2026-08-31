import { describe, expect, it } from 'vitest';
import type { Plan, PriceTier, Product } from '../api/types';
import {
  describePlanPrice,
  describePricingModel,
  describeTierRange,
  describeTierRate,
  describeTiers,
  formatInterval,
  formatPricingModel,
  groupPlansByProduct,
} from './plan';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    organizationId: 'org_1',
    productId: 'prod_1',
    name: 'Pro monthly',
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency: 'usd',
    flatAmount: 1999,
    usageMetric: null,
    usageUnitAmount: null,
    active: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTier(overrides: Partial<PriceTier> = {}): PriceTier {
  return {
    id: 'tier_1',
    planId: 'plan_1',
    order: 0,
    upTo: 1000,
    unitAmount: 5,
    flatFee: 0,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod_1',
    organizationId: 'org_1',
    name: 'API access',
    description: 'Metered API calls',
    active: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatInterval', () => {
  it('names the interval a price is quoted against', () => {
    expect(formatInterval('MONTH')).toBe('month');
    expect(formatInterval('YEAR')).toBe('year');
    expect(formatInterval('DAY')).toBe('day');
  });
});

describe('formatPricingModel', () => {
  it('labels each pricing model', () => {
    expect(formatPricingModel('FLAT')).toBe('Flat');
    expect(formatPricingModel('TIERED')).toBe('Tiered');
  });

  it('explains what each one means', () => {
    expect(describePricingModel('USAGE')).toContain('unit');
    expect(describePricingModel('TIERED')).toContain('tier');
  });
});

describe('describePlanPrice', () => {
  it('quotes a flat plan against its interval', () => {
    expect(describePlanPrice(makePlan())).toBe('$19.99 / month');
    expect(describePlanPrice(makePlan({ interval: 'YEAR', flatAmount: 199_00 }))).toBe(
      '$199.00 / year',
    );
  });

  it('quotes a usage plan as a rate per metric', () => {
    const plan = makePlan({
      pricingModel: 'USAGE',
      flatAmount: null,
      usageMetric: 'api_call',
      usageUnitAmount: 5,
    });

    expect(describePlanPrice(plan)).toBe('$0.05 per api_call');
  });

  it('summarizes a tiered plan by its metric and tier count', () => {
    const plan = makePlan({
      pricingModel: 'TIERED',
      flatAmount: null,
      usageMetric: 'api_call',
      tiers: [makeTier(), makeTier({ id: 'tier_2', order: 1, upTo: null, unitAmount: 3 })],
    });

    expect(describePlanPrice(plan)).toBe('Tiered on api_call · 2 tiers');
  });

  // A tiered plan is listed before its tiers are loaded on some screens;
  // it must still say what it meters rather than render as blank.
  it('still names the metric when no tiers came back', () => {
    const plan = makePlan({ pricingModel: 'TIERED', flatAmount: null, usageMetric: 'seat' });
    expect(describePlanPrice(plan)).toBe('Tiered on seat');
  });

  it('says so plainly when a flat plan has no price', () => {
    expect(describePlanPrice(makePlan({ flatAmount: null }))).toBe('No price set');
  });

  it('formats the price in the plan currency, not a hardcoded dollar', () => {
    expect(describePlanPrice(makePlan({ currency: 'eur' }))).toContain('€');
  });
});

describe('describeTierRange', () => {
  it('starts a band one unit above the previous bound', () => {
    expect(describeTierRange(makeTier({ upTo: 1000 }), 0)).toBe('1 – 1,000');
    expect(describeTierRange(makeTier({ upTo: 5000 }), 1000)).toBe('1,001 – 5,000');
  });

  it('describes the unbounded final band', () => {
    expect(describeTierRange(makeTier({ upTo: null }), 5000)).toBe('5,001 and above');
  });
});

describe('describeTierRate', () => {
  it('quotes the per-unit rate', () => {
    expect(describeTierRate(makeTier({ unitAmount: 5 }), 'usd')).toBe('$0.05 each');
  });

  it('includes a flat fee only when the tier charges one', () => {
    expect(describeTierRate(makeTier({ unitAmount: 5, flatFee: 1000 }), 'usd')).toBe(
      '$0.05 each + $10.00 flat',
    );
    expect(describeTierRate(makeTier({ flatFee: 0 }), 'usd')).not.toContain('flat');
  });
});

describe('describeTiers', () => {
  it('walks the bands so each row knows where it starts', () => {
    const plan = makePlan({
      pricingModel: 'TIERED',
      flatAmount: null,
      usageMetric: 'api_call',
      tiers: [
        makeTier({ id: 't1', order: 0, upTo: 1000, unitAmount: 5 }),
        makeTier({ id: 't2', order: 1, upTo: 10_000, unitAmount: 3 }),
        makeTier({ id: 't3', order: 2, upTo: null, unitAmount: 1 }),
      ],
    });

    expect(describeTiers(plan).map((row) => row.range)).toEqual([
      '1 – 1,000',
      '1,001 – 10,000',
      '10,001 and above',
    ]);
    expect(describeTiers(plan).map((row) => row.rate)).toEqual([
      '$0.05 each',
      '$0.03 each',
      '$0.01 each',
    ]);
  });

  it('returns nothing for a plan that has no tiers', () => {
    expect(describeTiers(makePlan())).toEqual([]);
  });
});

describe('groupPlansByProduct', () => {
  it('files each plan under its product', () => {
    const products = [makeProduct(), makeProduct({ id: 'prod_2', name: 'Support' })];
    const plans = [
      makePlan({ id: 'plan_1', productId: 'prod_1' }),
      makePlan({ id: 'plan_2', productId: 'prod_2' }),
      makePlan({ id: 'plan_3', productId: 'prod_1' }),
    ];

    const groups = groupPlansByProduct(plans, products);

    expect(groups.map((group) => group.productName)).toEqual(['API access', 'Support']);
    expect(groups[0]?.plans.map((plan) => plan.id)).toEqual(['plan_1', 'plan_3']);
    expect(groups[1]?.plans.map((plan) => plan.id)).toEqual(['plan_2']);
  });

  // An empty product is precisely where someone needs the "add a plan"
  // prompt, so it must not be dropped for having nothing under it.
  it('keeps a product that has no plans yet', () => {
    const groups = groupPlansByProduct([], [makeProduct()]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.plans).toEqual([]);
  });

  it('keeps a plan whose product is not in the list', () => {
    const groups = groupPlansByProduct([makePlan({ productId: 'prod_missing' })], []);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.productName).toBe('Unknown product');
    expect(groups[0]?.plans).toHaveLength(1);
  });
});
