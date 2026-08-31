import { describe, expect, it } from 'vitest';
import {
  emptyPlanForm,
  emptyTierRow,
  planFieldErrorsFrom,
  tierFieldKey,
  toCreatePlanInput,
  type PlanFormState,
} from './planForm';

function form(overrides: Partial<PlanFormState> = {}): PlanFormState {
  return { ...emptyPlanForm('prod_1'), name: 'Pro', ...overrides };
}

describe('emptyPlanForm', () => {
  it('starts as a monthly flat plan on the product it was opened from', () => {
    const state = emptyPlanForm('prod_9');

    expect(state.productId).toBe('prod_9');
    expect(state.pricingModel).toBe('FLAT');
    expect(state.interval).toBe('MONTH');
    expect(state.currency).toBe('usd');
  });

  // The smallest tier table that is already valid: one open-ended band.
  it('starts a tiered table with a single unbounded band', () => {
    expect(emptyPlanForm().tiers).toEqual([{ upTo: '', unitAmount: '', flatFee: '' }]);
  });
});

describe('toCreatePlanInput, flat plans', () => {
  it('builds a flat plan from the amount that was typed', () => {
    expect(toCreatePlanInput(form({ flatAmount: '19.99' }))).toEqual({
      ok: true,
      value: {
        productId: 'prod_1',
        name: 'Pro',
        interval: 'MONTH',
        currency: 'usd',
        pricingModel: 'FLAT',
        flatAmount: 1999,
      },
    });
  });

  it('requires a product, a name, and an amount', () => {
    const result = toCreatePlanInput(form({ productId: '', name: '', flatAmount: '' }));

    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { productId: 'Choose a product', name: 'Enter a name' },
    });
  });

  // A free flat plan is not a plan; the server rejects a non-positive
  // amount, so the form should say so before the round trip.
  it('rejects a zero flat amount', () => {
    expect(toCreatePlanInput(form({ flatAmount: '0' }))).toMatchObject({ ok: false });
  });

  it('rejects a currency that is not a 3-letter code', () => {
    expect(toCreatePlanInput(form({ flatAmount: '19.99', currency: 'dollars' }))).toMatchObject({
      ok: false,
      fieldErrors: { currency: 'Use a 3-letter code like usd' },
    });
  });

  it('parses the amount against the plan currency', () => {
    const result = toCreatePlanInput(form({ currency: 'jpy', flatAmount: '1999' }));

    expect(result).toMatchObject({ ok: true, value: { currency: 'jpy', flatAmount: 1999 } });
  });
});

describe('toCreatePlanInput, usage plans', () => {
  it('builds a usage plan from its metric and rate', () => {
    const result = toCreatePlanInput(
      form({ pricingModel: 'USAGE', usageMetric: ' api_call ', usageUnitAmount: '0.05' }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { pricingModel: 'USAGE', usageMetric: 'api_call', usageUnitAmount: 5 },
    });
  });

  // Metering something at no charge is a real configuration — a metric
  // recorded now and priced later — so zero is allowed for a rate.
  it('allows a zero rate', () => {
    expect(
      toCreatePlanInput(form({ pricingModel: 'USAGE', usageMetric: 'seat', usageUnitAmount: '0' })),
    ).toMatchObject({ ok: true, value: { usageUnitAmount: 0 } });
  });

  it('requires the metric it meters', () => {
    expect(
      toCreatePlanInput(form({ pricingModel: 'USAGE', usageUnitAmount: '0.05' })),
    ).toMatchObject({ ok: false, fieldErrors: { usageMetric: 'Enter the metric this plan meters' } });
  });
});

describe('toCreatePlanInput, tiered plans', () => {
  function tiered(tiers: PlanFormState['tiers']): PlanFormState {
    return form({ pricingModel: 'TIERED', usageMetric: 'api_call', tiers });
  }

  it('builds the bands in the order they were entered', () => {
    const result = toCreatePlanInput(
      tiered([
        { upTo: '1000', unitAmount: '0.05', flatFee: '' },
        { upTo: '10000', unitAmount: '0.03', flatFee: '10.00' },
        { upTo: '', unitAmount: '0.01', flatFee: '' },
      ]),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        pricingModel: 'TIERED',
        usageMetric: 'api_call',
        tiers: [
          { upTo: 1000, unitAmount: 5, flatFee: 0 },
          { upTo: 10_000, unitAmount: 3, flatFee: 1000 },
          { upTo: null, unitAmount: 1, flatFee: 0 },
        ],
      },
    });
  });

  it('reports a descending bound against the band that caused it', () => {
    const result = toCreatePlanInput(
      tiered([
        { upTo: '1000', unitAmount: '0.05', flatFee: '' },
        { upTo: '500', unitAmount: '0.03', flatFee: '' },
      ]),
    );

    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { [tierFieldKey(1, 'upTo')]: 'Must be greater than 1000' },
    });
  });

  // The server accepts an unbounded tier only as the last one; catching it
  // here points at the offending row instead of returning a sentence about
  // the table.
  it('rejects an unbounded band that is not the last', () => {
    const result = toCreatePlanInput(
      tiered([
        { upTo: '', unitAmount: '0.05', flatFee: '' },
        { upTo: '1000', unitAmount: '0.03', flatFee: '' },
      ]),
    );

    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { [tierFieldKey(0, 'upTo')]: 'Only the last tier can be unbounded' },
    });
  });

  it('rejects a fractional bound', () => {
    const result = toCreatePlanInput(tiered([{ upTo: '10.5', unitAmount: '0.05', flatFee: '' }]));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.fieldErrors[tierFieldKey(0, 'upTo')]).toContain('whole number');
    }
  });

  it('rejects an unreadable rate or flat fee on a band', () => {
    const result = toCreatePlanInput(
      tiered([{ upTo: '', unitAmount: 'five cents', flatFee: 'ten' }]),
    );

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.fieldErrors[tierFieldKey(0, 'unitAmount')]).toBeDefined();
      expect(result.fieldErrors[tierFieldKey(0, 'flatFee')]).toBeDefined();
    }
  });

  it('treats a blank flat fee as no fee', () => {
    const result = toCreatePlanInput(tiered([{ ...emptyTierRow(), unitAmount: '0.05' }]));

    expect(result).toMatchObject({ ok: true, value: { tiers: [{ flatFee: 0 }] } });
  });

  it('requires at least one band', () => {
    expect(toCreatePlanInput(tiered([]))).toMatchObject({
      ok: false,
      fieldErrors: { tiers: 'Add at least one tier' },
    });
  });
});

describe('planFieldErrorsFrom', () => {
  it('takes the first message per field', () => {
    expect(
      planFieldErrorsFrom({ flatAmount: ['Expected number', 'Must be positive'] }),
    ).toEqual({ flatAmount: 'Expected number' });
  });

  // `tiers` names the table rather than any one input, and the form has a
  // place to show it, so it is kept like every other key.
  it('keeps a message about the tier table as a whole', () => {
    expect(planFieldErrorsFrom({ tiers: ['At least one tier is required'] })).toEqual({
      tiers: 'At least one tier is required',
    });
  });

  it('ignores a field the server named with no message', () => {
    expect(planFieldErrorsFrom({ name: [], currency: undefined })).toEqual({});
  });
});
