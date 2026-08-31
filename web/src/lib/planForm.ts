import type { BillingInterval, CreatePlanInput, PriceTierInput, PricingModel } from '../api/types';
import { parseCurrencyCode, parseMoneyInput, parseWholeNumber } from './forms';

/**
 * The state behind the "new plan" form, and the conversion into the body
 * `POST /plans` accepts.
 *
 * A plan is the one form in the console where the *shape* of the request
 * changes with a dropdown: a flat plan carries an amount, a usage plan a
 * metric and a rate, a tiered plan a whole table of bands. The server
 * models that as a discriminated union, and so does this — which is why
 * the conversion is a function returning `CreatePlanInput` rather than a
 * pile of optional fields assembled in the component.
 *
 * Field errors are keyed the way the inputs are, including per-tier keys
 * like `tiers.1.upTo`, so a mistake in the fourth band is reported on the
 * fourth band rather than as a sentence about the table as a whole.
 */

export interface TierFormRow {
  /** Inclusive top of the band; empty means "and above". */
  upTo: string;
  unitAmount: string;
  flatFee: string;
}

export interface PlanFormState {
  productId: string;
  name: string;
  interval: BillingInterval;
  currency: string;
  pricingModel: PricingModel;
  flatAmount: string;
  usageMetric: string;
  usageUnitAmount: string;
  tiers: TierFormRow[];
}

export type PlanFieldErrors = Record<string, string>;

export type PlanFormResult =
  | { ok: true; value: CreatePlanInput }
  | { ok: false; fieldErrors: PlanFieldErrors };

export function emptyTierRow(): TierFormRow {
  return { upTo: '', unitAmount: '', flatFee: '' };
}

export function emptyPlanForm(productId = ''): PlanFormState {
  return {
    productId,
    name: '',
    interval: 'MONTH',
    currency: 'usd',
    pricingModel: 'FLAT',
    flatAmount: '',
    usageMetric: '',
    usageUnitAmount: '',
    // One unbounded band to start: the smallest table that is already valid.
    tiers: [emptyTierRow()],
  };
}

/** The key a tier field's error is filed under, e.g. `tiers.1.upTo`. */
export function tierFieldKey(index: number, field: keyof TierFormRow): string {
  return `tiers.${index}.${field}`;
}

function validateTiers(
  tiers: TierFormRow[],
  currency: string,
  errors: PlanFieldErrors,
): PriceTierInput[] {
  const parsed: PriceTierInput[] = [];
  let previousUpTo = 0;

  tiers.forEach((row, index) => {
    const isLast = index === tiers.length - 1;
    let upTo: number | null = null;

    if (row.upTo.trim() === '') {
      // Only the final band may be open-ended; an empty bound anywhere else
      // would leave a gap the server's ordering check rejects anyway.
      if (!isLast) {
        errors[tierFieldKey(index, 'upTo')] = 'Only the last tier can be unbounded';
      }
    } else {
      const bound = parseWholeNumber(row.upTo, { label: 'tier bound' });
      if (!bound.ok) {
        errors[tierFieldKey(index, 'upTo')] = bound.message;
      } else if (bound.value <= previousUpTo) {
        errors[tierFieldKey(index, 'upTo')] = `Must be greater than ${previousUpTo}`;
      } else {
        upTo = bound.value;
        previousUpTo = bound.value;
      }
    }

    // A tier can legitimately bill nothing per unit — a free allowance band
    // priced entirely through its flat fee — so zero is allowed here.
    const unit = parseMoneyInput(row.unitAmount, { currency, allowZero: true });
    if (!unit.ok) {
      errors[tierFieldKey(index, 'unitAmount')] = unit.message;
    }

    let flatFee = 0;
    if (row.flatFee.trim() !== '') {
      const fee = parseMoneyInput(row.flatFee, { currency, allowZero: true });
      if (!fee.ok) {
        errors[tierFieldKey(index, 'flatFee')] = fee.message;
      } else {
        flatFee = fee.value;
      }
    }

    if (unit.ok) {
      parsed.push({ upTo, unitAmount: unit.value, flatFee });
    }
  });

  return parsed;
}

export function toCreatePlanInput(state: PlanFormState): PlanFormResult {
  const errors: PlanFieldErrors = {};

  if (state.productId.trim() === '') {
    errors.productId = 'Choose a product';
  }
  if (state.name.trim() === '') {
    errors.name = 'Enter a name';
  }

  const currency = parseCurrencyCode(state.currency);
  if (!currency.ok) {
    errors.currency = currency.message;
  }
  // Amounts still have to be parsed against *something*; two decimals is
  // the right guess while the currency itself is being complained about.
  const currencyCode = currency.ok ? currency.value : 'usd';

  const base = {
    productId: state.productId.trim(),
    name: state.name.trim(),
    interval: state.interval,
    currency: currencyCode,
  };

  if (state.pricingModel === 'FLAT') {
    const amount = parseMoneyInput(state.flatAmount, { currency: currencyCode });
    if (!amount.ok) {
      errors.flatAmount = amount.message;
    }
    if (Object.keys(errors).length > 0 || !amount.ok) {
      return { ok: false, fieldErrors: errors };
    }
    return { ok: true, value: { ...base, pricingModel: 'FLAT', flatAmount: amount.value } };
  }

  const metric = state.usageMetric.trim();
  if (metric === '') {
    errors.usageMetric = 'Enter the metric this plan meters';
  }

  if (state.pricingModel === 'USAGE') {
    const rate = parseMoneyInput(state.usageUnitAmount, {
      currency: currencyCode,
      allowZero: true,
    });
    if (!rate.ok) {
      errors.usageUnitAmount = rate.message;
    }
    if (Object.keys(errors).length > 0 || !rate.ok) {
      return { ok: false, fieldErrors: errors };
    }
    return {
      ok: true,
      value: { ...base, pricingModel: 'USAGE', usageMetric: metric, usageUnitAmount: rate.value },
    };
  }

  if (state.tiers.length === 0) {
    errors.tiers = 'Add at least one tier';
  }
  const tiers = validateTiers(state.tiers, currencyCode, errors);

  if (Object.keys(errors).length > 0) {
    return { ok: false, fieldErrors: errors };
  }
  return { ok: true, value: { ...base, pricingModel: 'TIERED', usageMetric: metric, tiers } };
}

/**
 * The server's per-field messages reduced to one per field.
 *
 * Unlike the customer form, every key is kept: the plan form's fields are
 * named exactly as the server's schema names them, and a message about
 * `tiers` belongs on the tier table even though no single input owns it.
 */
export function planFieldErrorsFrom(
  fieldErrors: Record<string, string[] | undefined>,
): PlanFieldErrors {
  const errors: PlanFieldErrors = {};
  for (const [key, messages] of Object.entries(fieldErrors)) {
    const message = messages?.[0];
    if (message) {
      errors[key] = message;
    }
  }
  return errors;
}
