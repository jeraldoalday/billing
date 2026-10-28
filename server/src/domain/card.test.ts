import { describe, expect, it } from 'vitest';
import { detectCardBrand, isCardExpired, isValidLuhn, lastFour } from './card';

describe('detectCardBrand', () => {
  it('detects Visa numbers starting with 4', () => {
    expect(detectCardBrand('4242424242424242')).toBe('VISA');
  });

  it('detects Mastercard numbers in the 51-55 range', () => {
    expect(detectCardBrand('5555555555554444')).toBe('MASTERCARD');
  });

  it('detects Mastercard numbers in the newer 2221-2720 range', () => {
    expect(detectCardBrand('2223000048400011')).toBe('MASTERCARD');
    expect(detectCardBrand('2720000000000000')).toBe('MASTERCARD');
  });

  it('does not misclassify numbers just outside the 2221-2720 range', () => {
    expect(detectCardBrand('2220000000000000')).toBe('UNKNOWN');
    expect(detectCardBrand('2721000000000000')).toBe('UNKNOWN');
  });

  it('detects Amex numbers starting with 34 or 37', () => {
    expect(detectCardBrand('378282246310005')).toBe('AMEX');
    expect(detectCardBrand('341111111111111')).toBe('AMEX');
  });

  it('detects Discover numbers starting with 6011 or 65', () => {
    expect(detectCardBrand('6011111111111117')).toBe('DISCOVER');
    expect(detectCardBrand('6500000000000002')).toBe('DISCOVER');
  });

  it('falls back to UNKNOWN for anything else', () => {
    expect(detectCardBrand('9999999999999995')).toBe('UNKNOWN');
  });
});

describe('lastFour', () => {
  it('returns the last four digits of a card number', () => {
    expect(lastFour('4242424242424242')).toBe('4242');
  });
});

describe('isValidLuhn', () => {
  it('accepts well-known test card numbers', () => {
    expect(isValidLuhn('4242424242424242')).toBe(true);
    expect(isValidLuhn('5555555555554444')).toBe(true);
    expect(isValidLuhn('378282246310005')).toBe(true);
  });

  it('rejects a number with a single transposed or mistyped digit', () => {
    expect(isValidLuhn('4242424242424241')).toBe(false);
  });

  it('rejects a non-digit character the length regex would already exclude', () => {
    expect(isValidLuhn('424242424242424a')).toBe(false);
  });
});

describe('isCardExpired', () => {
  it('is not expired during its expiry month', () => {
    const now = new Date('2026-03-15T12:00:00.000Z');
    expect(isCardExpired(3, 2026, now)).toBe(false);
  });

  it('is not expired in the final instant of its expiry month', () => {
    const now = new Date('2026-03-31T23:59:59.999Z');
    expect(isCardExpired(3, 2026, now)).toBe(false);
  });

  it('is expired the moment the month after expiry begins', () => {
    const now = new Date('2026-04-01T00:00:00.000Z');
    expect(isCardExpired(3, 2026, now)).toBe(true);
  });

  it('is expired for a year that has already passed', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(isCardExpired(12, 2025, now)).toBe(true);
  });

  it('is not expired for a year that has not started yet', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(isCardExpired(1, 2027, now)).toBe(false);
  });
});
