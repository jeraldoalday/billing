import { describe, expect, it } from 'vitest';
import type { Customer } from '../api/types';
import {
  customerFieldErrorsFrom,
  customerFormFrom,
  emptyCustomerForm,
  filterCustomers,
  isEmptyUpdate,
  toCreateCustomerInput,
  toUpdateCustomerInput,
  type CustomerFormState,
} from './customerForm';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cus_1',
    organizationId: 'org_1',
    name: 'Ada Lovelace',
    email: 'ada@analytical.test',
    active: true,
    country: 'GB',
    taxId: 'GB123456789',
    taxExempt: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function filled(overrides: Partial<CustomerFormState> = {}): CustomerFormState {
  return { ...emptyCustomerForm(), name: 'Ada', email: 'ada@test.com', ...overrides };
}

describe('customerFormFrom', () => {
  it('fills the form from a loaded customer', () => {
    expect(customerFormFrom(makeCustomer())).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@analytical.test',
      country: 'GB',
      taxId: 'GB123456789',
      taxExempt: false,
      active: true,
    });
  });

  // A form field holds a string; null would render as "null" in the input.
  it('shows an absent country or tax id as an empty field', () => {
    const form = customerFormFrom(makeCustomer({ country: null, taxId: null }));

    expect(form.country).toBe('');
    expect(form.taxId).toBe('');
  });
});

describe('toCreateCustomerInput', () => {
  it('normalizes what was typed into what the API stores', () => {
    const result = toCreateCustomerInput(
      filled({ name: '  Ada  ', email: '  Ada@Test.com ', country: 'gb', taxId: 'gb 123-456789' }),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Ada',
        email: 'ada@test.com',
        country: 'GB',
        taxId: 'GB123456789',
        taxExempt: false,
      },
    });
  });

  // The create schema has no null for these; an empty string fails its
  // length check, so an untouched field must be left out entirely.
  it('omits an untouched country and tax id rather than sending empty ones', () => {
    const result = toCreateCustomerInput(filled());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty('country');
      expect(result.value).not.toHaveProperty('taxId');
    }
  });

  it('reports a missing name and email against their own fields', () => {
    const result = toCreateCustomerInput(emptyCustomerForm());

    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { name: 'Enter a name', email: 'Enter an email address' },
    });
  });

  it('catches an obviously malformed email before the round trip', () => {
    const result = toCreateCustomerInput(filled({ email: 'ada@test' }));

    expect(result).toMatchObject({ ok: false, fieldErrors: { email: 'Enter a valid email address' } });
  });

  it('rejects a country that is not a 2-letter code', () => {
    expect(toCreateCustomerInput(filled({ country: 'United Kingdom' }))).toMatchObject({
      ok: false,
    });
  });

  it('rejects a tax id that is too short to be a registration number', () => {
    expect(toCreateCustomerInput(filled({ taxId: 'GB1' }))).toMatchObject({ ok: false });
  });

  it('carries the tax exemption through', () => {
    const result = toCreateCustomerInput(filled({ taxExempt: true }));

    expect(result).toMatchObject({ ok: true, value: { taxExempt: true } });
  });
});

describe('toUpdateCustomerInput', () => {
  const customer = makeCustomer();

  it('sends only what actually changed', () => {
    const state = { ...customerFormFrom(customer), name: 'Ada King' };

    expect(toUpdateCustomerInput(state, customer)).toEqual({
      ok: true,
      value: { name: 'Ada King' },
    });
  });

  // Omitting a field means "leave it alone", so clearing one has to be an
  // explicit null or the value would silently survive the edit.
  it('clears a removed country or tax id with an explicit null', () => {
    const state = { ...customerFormFrom(customer), country: '', taxId: '' };

    expect(toUpdateCustomerInput(state, customer)).toEqual({
      ok: true,
      value: { country: null, taxId: null },
    });
  });

  it('reports an unchanged form as nothing to save', () => {
    const result = toUpdateCustomerInput(customerFormFrom(customer), customer);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isEmptyUpdate(result.value)).toBe(true);
    }
  });

  it('does not count a whitespace or case difference as a change', () => {
    const state = { ...customerFormFrom(customer), name: '  Ada Lovelace  ', email: 'ADA@analytical.test' };
    const result = toUpdateCustomerInput(state, customer);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isEmptyUpdate(result.value)).toBe(true);
    }
  });

  it('carries a deactivation and a tax-exemption change', () => {
    const state = { ...customerFormFrom(customer), active: false, taxExempt: true };

    expect(toUpdateCustomerInput(state, customer)).toEqual({
      ok: true,
      value: { active: false, taxExempt: true },
    });
  });

  it('validates before diffing', () => {
    const state = { ...customerFormFrom(customer), email: 'not-an-email' };

    expect(toUpdateCustomerInput(state, customer)).toMatchObject({ ok: false });
  });
});

describe('filterCustomers', () => {
  const customers = [
    makeCustomer({ id: 'cus_1', name: 'Ada Lovelace', email: 'ada@analytical.test' }),
    makeCustomer({ id: 'cus_2', name: 'Grace Hopper', email: 'grace@navy.test' }),
  ];

  it('returns everything for an empty search', () => {
    expect(filterCustomers(customers, '   ')).toHaveLength(2);
  });

  it('matches on a fragment of the name or the email, either case', () => {
    expect(filterCustomers(customers, 'grac').map((c) => c.id)).toEqual(['cus_2']);
    expect(filterCustomers(customers, 'ANALYTICAL').map((c) => c.id)).toEqual(['cus_1']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterCustomers(customers, 'zzz')).toEqual([]);
  });
});

describe('customerFieldErrorsFrom', () => {
  it('takes the first message the server gave for each field', () => {
    expect(
      customerFieldErrorsFrom({
        email: ['Invalid email', 'Also too long'],
        name: ['String must contain at least 1 character(s)'],
      }),
    ).toEqual({
      email: 'Invalid email',
      name: 'String must contain at least 1 character(s)',
    });
  });

  // A message about a field with no input on screen has nowhere to go; the
  // form-level alert is what covers those.
  it('ignores fields this form does not render', () => {
    expect(customerFieldErrorsFrom({ organizationId: ['Not allowed'] })).toEqual({});
  });

  it('is empty when the failure named no fields', () => {
    expect(customerFieldErrorsFrom({})).toEqual({});
  });
});
