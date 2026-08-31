/**
 * Turning what a person typed into what the API stores.
 *
 * Every write in the console goes through a form, and every one of those
 * forms has the same problem: the field holds a string, the endpoint wants
 * an integer. Money is the sharp case — the API counts minor units, so
 * `19.99` has to become `1999` without ever letting a rounding slip put a
 * customer on the wrong price. Parsing therefore lives here, in one tested
 * place, and returns a result a form can render rather than throwing.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function failure(message: string): ParseResult<never> {
  return { ok: false, message };
}

/**
 * How many decimal places a currency has: 2 for USD, 0 for JPY.
 *
 * Asked of `Intl` rather than hardcoded to 100, for the same reason
 * `formatMoney` does — a zero-decimal currency has no cents to parse, and
 * `¥19.99` is not an amount that exists. An unknown code makes `Intl`
 * throw, in which case the near-universal 2 is the safest guess.
 */
export function currencyExponent(currency: string, locale = 'en-US'): number {
  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
    });
    return formatter.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export interface ParseMoneyOptions {
  currency?: string;
  /** Allow `0`, for a usage rate that is genuinely free. */
  allowZero?: boolean;
}

/**
 * Reads a typed amount as integer minor units: `"19.99"` becomes `1999`.
 *
 * Digits are counted rather than multiplied — `Math.round(19.99 * 100)` is
 * right here but the same expression is off by one cent for other amounts,
 * and a billing console is the last place to accept that class of bug.
 */
export function parseMoneyInput(input: string, options: ParseMoneyOptions = {}): ParseResult<number> {
  const currency = options.currency ?? 'usd';
  const allowZero = options.allowZero ?? false;

  // Thousands separators and stray spaces are how people actually type an
  // amount; neither carries meaning, so both are dropped before parsing.
  const cleaned = input.trim().replace(/[\s,]/g, '');
  if (cleaned === '') {
    return failure('Enter an amount');
  }
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return failure('Enter an amount like 19.99');
  }

  const digits = currencyExponent(currency);
  const [whole = '0', fraction = ''] = cleaned.split('.');

  if (fraction.length > digits) {
    return failure(
      digits === 0
        ? `${currency.toUpperCase()} amounts have no decimal places`
        : `Use at most ${digits} decimal place${digits === 1 ? '' : 's'}`,
    );
  }

  const minorUnits = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');

  if (!Number.isSafeInteger(minorUnits)) {
    return failure('That amount is too large');
  }
  if (!allowZero && minorUnits === 0) {
    return failure('Enter an amount greater than zero');
  }

  return { ok: true, value: minorUnits };
}

/** The inverse: minor units as the decimal string a form field shows. */
export function toMoneyInput(minorUnits: number | null | undefined, currency = 'usd'): string {
  if (minorUnits === null || minorUnits === undefined || !Number.isFinite(minorUnits)) {
    return '';
  }
  const digits = currencyExponent(currency);
  return (minorUnits / 10 ** digits).toFixed(digits);
}

export interface ParseWholeNumberOptions {
  /** Lowest accepted value; defaults to 1, the smallest useful quantity. */
  min?: number;
  max?: number;
  /** Named in the message, so a form with several counts stays legible. */
  label?: string;
}

/** Reads a typed count — a tier bound, a trial length — as an integer. */
export function parseWholeNumber(
  input: string,
  options: ParseWholeNumberOptions = {},
): ParseResult<number> {
  const min = options.min ?? 1;
  const label = options.label ?? 'value';
  const cleaned = input.trim().replace(/[\s,]/g, '');

  if (cleaned === '') {
    return failure(`Enter a ${label}`);
  }
  if (!/^\d+$/.test(cleaned)) {
    return failure(`The ${label} must be a whole number`);
  }

  const value = Number(cleaned);
  if (!Number.isSafeInteger(value)) {
    return failure(`That ${label} is too large`);
  }
  if (value < min) {
    return failure(`The ${label} must be at least ${min}`);
  }
  if (options.max !== undefined && value > options.max) {
    return failure(`The ${label} must be at most ${options.max}`);
  }

  return { ok: true, value };
}

/** A currency code the API will accept: exactly three letters. */
export function parseCurrencyCode(input: string): ParseResult<string> {
  const cleaned = input.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(cleaned)) {
    return failure('Use a 3-letter code like usd');
  }
  return { ok: true, value: cleaned };
}

/**
 * A 2-letter ISO 3166-1 country, or `null` when the field was left blank —
 * the customer endpoints treat an absent country as "not stated" rather
 * than as an error, so an empty box must not become a validation failure.
 */
export function parseOptionalCountry(input: string): ParseResult<string | null> {
  const cleaned = input.trim().toUpperCase();
  if (cleaned === '') {
    return { ok: true, value: null };
  }
  if (!/^[A-Z]{2}$/.test(cleaned)) {
    return failure('Use a 2-letter country code like GB');
  }
  return { ok: true, value: cleaned };
}
