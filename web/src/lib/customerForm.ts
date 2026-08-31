import type { CreateCustomerInput, Customer, UpdateCustomerInput } from '../api/types';
import { parseOptionalCountry } from './forms';

/**
 * The state behind the customer create and edit forms, and the two
 * conversions that turn it into a request body.
 *
 * Kept out of the components because the interesting part is not the
 * markup: it is that creating sends everything, while editing must send
 * *only what changed* — the API's update schema rejects an empty body and
 * treats an omitted field as "leave it alone", so a form that always sent
 * every field would overwrite a value someone else had just changed.
 */

export interface CustomerFormState {
  name: string;
  email: string;
  country: string;
  taxId: string;
  taxExempt: boolean;
  active: boolean;
}

/** Per-field messages, keyed by the API's field names. */
export type CustomerFieldErrors = Partial<Record<keyof CustomerFormState, string>>;

export type CustomerFormResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: CustomerFieldErrors };

export function emptyCustomerForm(): CustomerFormState {
  return { name: '', email: '', country: '', taxId: '', taxExempt: false, active: true };
}

export function customerFormFrom(customer: Customer): CustomerFormState {
  return {
    name: customer.name,
    email: customer.email,
    country: customer.country ?? '',
    taxId: customer.taxId ?? '',
    taxExempt: customer.taxExempt,
    active: customer.active,
  };
}

/**
 * A VAT/GST registration as the API stores it: uppercase, no spaces or
 * dashes, so `GB 123-456` and `gb123456` are the same string by the time
 * the reverse-charge check on the server sees them.
 */
function normalizeTaxId(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}

function validate(state: CustomerFormState): CustomerFieldErrors {
  const errors: CustomerFieldErrors = {};

  if (state.name.trim() === '') {
    errors.name = 'Enter a name';
  }

  const email = state.email.trim();
  if (email === '') {
    errors.email = 'Enter an email address';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // A cheap shape check to catch a typo before a round trip; the server
    // remains the authority on whether the address is acceptable.
    errors.email = 'Enter a valid email address';
  }

  const country = parseOptionalCountry(state.country);
  if (!country.ok) {
    errors.country = country.message;
  }

  const taxId = normalizeTaxId(state.taxId);
  if (taxId !== '' && (taxId.length < 4 || taxId.length > 20)) {
    errors.taxId = 'Enter a registration number of 4 to 20 characters';
  }

  return errors;
}

/** Everything the form holds, as `POST /customers` wants it. */
export function toCreateCustomerInput(
  state: CustomerFormState,
): CustomerFormResult<CreateCustomerInput> {
  const fieldErrors = validate(state);
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const input: CreateCustomerInput = {
    name: state.name.trim(),
    email: state.email.trim().toLowerCase(),
    taxExempt: state.taxExempt,
  };

  // Absent rather than empty: the create schema has no null for these, and
  // an empty string would fail its length check.
  const country = state.country.trim().toUpperCase();
  if (country !== '') {
    input.country = country;
  }
  const taxId = normalizeTaxId(state.taxId);
  if (taxId !== '') {
    input.taxId = taxId;
  }

  return { ok: true, value: input };
}

/**
 * Only the fields that differ from the customer as loaded.
 *
 * A cleared country or tax id becomes an explicit `null` — the update
 * schema's way of saying "remove this" — while an unchanged field is left
 * out entirely. An empty result means there is nothing to save, which the
 * form reports without troubling the server for a 400.
 */
export function toUpdateCustomerInput(
  state: CustomerFormState,
  original: Customer,
): CustomerFormResult<UpdateCustomerInput> {
  const fieldErrors = validate(state);
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const input: UpdateCustomerInput = {};

  const name = state.name.trim();
  if (name !== original.name) {
    input.name = name;
  }

  const email = state.email.trim().toLowerCase();
  if (email !== original.email) {
    input.email = email;
  }

  const country = state.country.trim().toUpperCase();
  const originalCountry = original.country ?? '';
  if (country !== originalCountry) {
    input.country = country === '' ? null : country;
  }

  const taxId = normalizeTaxId(state.taxId);
  const originalTaxId = original.taxId ?? '';
  if (taxId !== originalTaxId) {
    input.taxId = taxId === '' ? null : taxId;
  }

  if (state.taxExempt !== original.taxExempt) {
    input.taxExempt = state.taxExempt;
  }

  if (state.active !== original.active) {
    input.active = state.active;
  }

  return { ok: true, value: input };
}

/** True when an edit would send nothing, so the form can say so. */
export function isEmptyUpdate(input: UpdateCustomerInput): boolean {
  return Object.keys(input).length === 0;
}

/**
 * Narrows a customer list to what someone typed in the search box.
 *
 * Filtering happens in the browser rather than through the API's `email`
 * filter because that filter is an exact match — useful for a lookup by
 * address, useless for typing three letters of a name.
 */
export function filterCustomers(customers: Customer[], search: string): Customer[] {
  const needle = search.trim().toLowerCase();
  if (needle === '') {
    return customers;
  }
  return customers.filter(
    (customer) =>
      customer.name.toLowerCase().includes(needle) ||
      customer.email.toLowerCase().includes(needle),
  );
}

/**
 * The server's per-field messages, reduced to the one message per field a
 * form can render.
 *
 * `ApiError.fieldErrors` is Zod's `flatten()` output — an array per field,
 * keyed by whatever the schema calls it. Only the fields this form has an
 * input for are kept, so a message about a field the user cannot see does
 * not vanish into a component that has nowhere to put it.
 */
export function customerFieldErrorsFrom(
  fieldErrors: Record<string, string[] | undefined>,
): CustomerFieldErrors {
  const keys: (keyof CustomerFormState)[] = [
    'name',
    'email',
    'country',
    'taxId',
    'taxExempt',
    'active',
  ];

  const errors: CustomerFieldErrors = {};
  for (const key of keys) {
    const message = fieldErrors[key]?.[0];
    if (message) {
      errors[key] = message;
    }
  }
  return errors;
}
