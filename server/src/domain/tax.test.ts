import { describe, expect, it } from 'vitest';
import { calculateTax, taxRateForCountry } from './tax';

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
  it('applies a country rate to the subtotal', () => {
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
