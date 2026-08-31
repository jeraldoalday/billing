import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  parseCurrencyCode,
  parseMoneyInput,
  parseOptionalCountry,
  parseWholeNumber,
  toMoneyInput,
  type ParseResult,
} from './forms';

/** Narrows a result to its value, failing the test if it did not parse. */
function value<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected a successful parse, got: ${JSON.stringify(result)}`);
  }
  return result.value;
}

describe('currencyExponent', () => {
  it('reports the minor units a currency actually has', () => {
    expect(currencyExponent('usd')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
  });

  it('falls back to two places for a code Intl does not know', () => {
    expect(currencyExponent('zzz')).toBe(2);
  });
});

describe('parseMoneyInput', () => {
  it('reads a decimal amount as minor units', () => {
    expect(value(parseMoneyInput('19.99'))).toBe(1999);
    expect(value(parseMoneyInput('19'))).toBe(1900);
    expect(value(parseMoneyInput('0.05'))).toBe(5);
  });

  // 0.1 + 0.2 arithmetic has no business anywhere near a price: the digits
  // are counted, so a one-decimal amount pads rather than multiplies.
  it('pads a short fraction instead of multiplying through a float', () => {
    expect(value(parseMoneyInput('19.9'))).toBe(1990);
    expect(value(parseMoneyInput('1234.56'))).toBe(123_456);
  });

  it('ignores separators and surrounding whitespace', () => {
    expect(value(parseMoneyInput(' 1,234.56 '))).toBe(123_456);
  });

  it('rejects anything that is not a plain amount', () => {
    expect(parseMoneyInput('$19.99')).toMatchObject({ ok: false });
    expect(parseMoneyInput('nineteen')).toMatchObject({ ok: false });
    expect(parseMoneyInput('-5.00')).toMatchObject({ ok: false });
    expect(parseMoneyInput('')).toMatchObject({ ok: false, message: 'Enter an amount' });
  });

  it('rejects more precision than the currency has', () => {
    expect(parseMoneyInput('19.999')).toMatchObject({
      ok: false,
      message: 'Use at most 2 decimal places',
    });
    expect(parseMoneyInput('1999.5', { currency: 'jpy' })).toMatchObject({
      ok: false,
      message: 'JPY amounts have no decimal places',
    });
  });

  it('reads a zero-decimal currency at face value', () => {
    expect(value(parseMoneyInput('1999', { currency: 'jpy' }))).toBe(1999);
  });

  it('rejects zero unless the caller allows it', () => {
    expect(parseMoneyInput('0')).toMatchObject({ ok: false });
    expect(value(parseMoneyInput('0', { allowZero: true }))).toBe(0);
  });

  it('rejects an amount too large to stay exact', () => {
    expect(parseMoneyInput('999999999999999999')).toMatchObject({
      ok: false,
      message: 'That amount is too large',
    });
  });
});

describe('toMoneyInput', () => {
  it('renders minor units as an editable decimal', () => {
    expect(toMoneyInput(1999)).toBe('19.99');
    expect(toMoneyInput(0)).toBe('0.00');
    expect(toMoneyInput(1999, 'jpy')).toBe('1999');
  });

  it('renders an absent amount as an empty field', () => {
    expect(toMoneyInput(null)).toBe('');
    expect(toMoneyInput(undefined)).toBe('');
  });

  // A round trip is what a plan edit form does: read, show, read back.
  it('round-trips through parseMoneyInput', () => {
    expect(value(parseMoneyInput(toMoneyInput(123_456)))).toBe(123_456);
  });
});

describe('parseWholeNumber', () => {
  it('reads a count', () => {
    expect(value(parseWholeNumber('1000'))).toBe(1000);
    expect(value(parseWholeNumber(' 1,000 '))).toBe(1000);
  });

  it('rejects a fractional or non-numeric count', () => {
    expect(parseWholeNumber('10.5', { label: 'tier bound' })).toMatchObject({
      ok: false,
      message: 'The tier bound must be a whole number',
    });
    expect(parseWholeNumber('lots')).toMatchObject({ ok: false });
  });

  it('enforces the bounds it was given', () => {
    expect(parseWholeNumber('0')).toMatchObject({ ok: false });
    expect(value(parseWholeNumber('0', { min: 0 }))).toBe(0);
    expect(parseWholeNumber('400', { max: 365, label: 'trial length' })).toMatchObject({
      ok: false,
      message: 'The trial length must be at most 365',
    });
  });

  it('names the field in its message', () => {
    expect(parseWholeNumber('', { label: 'quantity' })).toMatchObject({
      ok: false,
      message: 'Enter a quantity',
    });
  });
});

describe('parseCurrencyCode', () => {
  it('normalizes a code to what the API expects', () => {
    expect(value(parseCurrencyCode(' USD '))).toBe('usd');
  });

  it('rejects anything but three letters', () => {
    expect(parseCurrencyCode('dollars')).toMatchObject({ ok: false });
    expect(parseCurrencyCode('us')).toMatchObject({ ok: false });
  });
});

describe('parseOptionalCountry', () => {
  it('uppercases a country the way the API stores it', () => {
    expect(value(parseOptionalCountry('gb'))).toBe('GB');
  });

  // Blank means "not stated", which the customer endpoints accept; turning
  // it into an error would make the field impossible to leave empty.
  it('reads a blank field as no country rather than an error', () => {
    expect(value(parseOptionalCountry('   '))).toBeNull();
  });

  it('rejects a country that is not a 2-letter code', () => {
    expect(parseOptionalCountry('United Kingdom')).toMatchObject({ ok: false });
  });
});
