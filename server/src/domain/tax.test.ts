import { describe, expect, it } from 'vitest';
import {
  calculateCustomerTax,
  calculateTax,
  isEuMemberState,
  isVatIdShapeValid,
  resolveTaxTreatment,
  taxRateForCountry,
} from './tax';

describe('taxRateForCountry', () => {
  it('returns the rate for a known country, case-insensitively', () => {
    expect(taxRateForCountry('GB')).toBe(20);
    expect(taxRateForCountry('gb')).toBe(20);
  });

  it('returns 0 for a country with no sales tax modeled', () => {
    expect(taxRateForCountry('US')).toBe(0);
  });

  it('returns 0 for an unrecognized country', () => {
    expect(taxRateForCountry('ZZ')).toBe(0);
  });

  it('returns 0 for a missing country', () => {
    expect(taxRateForCountry(null)).toBe(0);
    expect(taxRateForCountry(undefined)).toBe(0);
  });
});

describe('calculateTax', () => {
  it('applies a country rate to the taxable amount', () => {
    expect(calculateTax(10000, 'GB')).toBe(2000);
    expect(calculateTax(10000, 'DE')).toBe(1900);
  });

  it('charges no tax for a customer with no country on file', () => {
    expect(calculateTax(10000, null)).toBe(0);
  });

  it('rounds to the nearest whole minor currency unit', () => {
    // Singapore's 9% of 333 = 29.97, rounds to 30.
    expect(calculateTax(333, 'SG')).toBe(30);
  });
});

describe('isEuMemberState', () => {
  it('recognizes member states case-insensitively', () => {
    expect(isEuMemberState('DE')).toBe(true);
    expect(isEuMemberState('ie')).toBe(true);
  });

  it('excludes the UK, which left the EU VAT area', () => {
    expect(isEuMemberState('GB')).toBe(false);
  });

  it('excludes non-members and a missing country', () => {
    expect(isEuMemberState('US')).toBe(false);
    expect(isEuMemberState(null)).toBe(false);
  });
});

describe('isVatIdShapeValid', () => {
  it('accepts a well-formed id whose prefix matches the customer country', () => {
    expect(isVatIdShapeValid('DE123456789', 'DE')).toBe(true);
  });

  it('ignores spacing and case', () => {
    expect(isVatIdShapeValid('ie 6388047 V', 'IE')).toBe(true);
  });

  it('rejects an id issued by a different country than the customer is in', () => {
    expect(isVatIdShapeValid('FR12345678901', 'DE')).toBe(false);
  });

  it('rejects ids that are too short or not country-prefixed', () => {
    expect(isVatIdShapeValid('DE1', 'DE')).toBe(false);
    expect(isVatIdShapeValid('123456789', 'DE')).toBe(false);
  });

  it('accepts a well-formed id when no country is on file to check it against', () => {
    expect(isVatIdShapeValid('DE123456789', null)).toBe(true);
  });
});

describe('resolveTaxTreatment', () => {
  it('applies the country rate to an ordinary customer', () => {
    expect(resolveTaxTreatment({ country: 'DE' })).toEqual({ treatment: 'STANDARD', rate: 19 });
  });

  it('charges nothing to a customer with an exemption on file', () => {
    expect(resolveTaxTreatment({ country: 'DE', taxExempt: true })).toEqual({
      treatment: 'EXEMPT',
      rate: 0,
    });
  });

  it('lets an exemption override a VAT id', () => {
    const treatment = resolveTaxTreatment({ country: 'DE', taxId: 'DE123456789', taxExempt: true });

    expect(treatment.treatment).toBe('EXEMPT');
  });

  it('reverse-charges an EU business that supplied a matching VAT id', () => {
    expect(resolveTaxTreatment({ country: 'IE', taxId: 'IE6388047V' })).toEqual({
      treatment: 'REVERSE_CHARGE',
      rate: 0,
    });
  });

  it('charges an EU consumer with no VAT id their own country rate', () => {
    expect(resolveTaxTreatment({ country: 'IE' })).toEqual({ treatment: 'STANDARD', rate: 23 });
  });

  it('charges the standard rate when the supplied VAT id is malformed', () => {
    expect(resolveTaxTreatment({ country: 'DE', taxId: 'not-a-vat-id' })).toEqual({
      treatment: 'STANDARD',
      rate: 19,
    });
  });

  it('does not reverse-charge a non-EU business', () => {
    expect(resolveTaxTreatment({ country: 'GB', taxId: 'GB123456789' })).toEqual({
      treatment: 'STANDARD',
      rate: 20,
    });
  });

  it('reports no jurisdiction for a customer with no country on file', () => {
    expect(resolveTaxTreatment({})).toEqual({ treatment: 'NO_JURISDICTION', rate: 0 });
  });
});

describe('calculateCustomerTax', () => {
  it('taxes an ordinary customer at their country rate', () => {
    expect(calculateCustomerTax(10000, { country: 'GB' })).toEqual({
      treatment: 'STANDARD',
      rate: 20,
      amount: 2000,
    });
  });

  it('taxes an exempt customer nothing and says so', () => {
    expect(calculateCustomerTax(10000, { country: 'GB', taxExempt: true })).toEqual({
      treatment: 'EXEMPT',
      rate: 0,
      amount: 0,
    });
  });

  it('taxes a reverse-charged supply nothing and says so', () => {
    expect(calculateCustomerTax(10000, { country: 'NL', taxId: 'NL123456789B01' })).toEqual({
      treatment: 'REVERSE_CHARGE',
      rate: 0,
      amount: 0,
    });
  });

  it('taxes the discounted amount it is given, not the pre-discount one', () => {
    // 20% of a 10000 subtotal less a 2500 coupon is 1500, not 2000.
    expect(calculateCustomerTax(7500, { country: 'GB' }).amount).toBe(1500);
  });

  it('returns tax on a credit as a negative amount', () => {
    expect(calculateCustomerTax(-5000, { country: 'GB' }).amount).toBe(-1000);
  });
});
