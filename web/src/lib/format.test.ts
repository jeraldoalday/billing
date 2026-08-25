import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  formatDate,
  formatMoney,
  formatPercent,
  humanizeStatus,
  initialsFor,
  pluralize,
} from './format';

describe('formatMoney', () => {
  it('formats cents as dollars', () => {
    expect(formatMoney(1999, 'usd')).toBe('$19.99');
    expect(formatMoney(0, 'usd')).toBe('$0.00');
  });

  it('formats a negative amount, as a proration credit is stored', () => {
    expect(formatMoney(-500, 'usd')).toBe('-$5.00');
  });

  it('accepts the currency in either case', () => {
    expect(formatMoney(1000, 'USD')).toBe(formatMoney(1000, 'usd'));
  });

  // JPY has no minor unit; dividing by 100 would show ¥19.99 for ¥1999.
  it('does not invent decimals for a zero-decimal currency', () => {
    expect(formatMoney(1999, 'jpy', 'en-US')).toBe('¥1,999');
  });

  it('groups thousands', () => {
    expect(formatMoney(1_234_567, 'usd')).toBe('$12,345.67');
  });
});

describe('formatPercent', () => {
  it('renders a ratio as a percentage', () => {
    expect(formatPercent(0.0731)).toBe('7.31%');
    expect(formatPercent(1)).toBe('100.00%');
  });

  it('honours the requested precision', () => {
    expect(formatPercent(0.0731, 0)).toBe('7%');
  });

  // A churn rate over an empty cohort divides by zero upstream.
  it('renders a dash for a non-finite ratio', () => {
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDate', () => {
  it('formats an ISO timestamp', () => {
    expect(formatDate('2026-08-25T10:30:00.000Z')).toBe('25 Aug 2026');
  });

  it('renders a dash for a missing or unparseable value', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });
});

describe('daysUntil', () => {
  const now = new Date('2026-08-25T00:00:00.000Z');

  it('counts forward to a future date', () => {
    expect(daysUntil('2026-09-01T00:00:00.000Z', now)).toBe(7);
  });

  it('is zero for today', () => {
    expect(daysUntil('2026-08-25T06:00:00.000Z', now)).toBe(0);
  });

  it('goes negative once the date has passed', () => {
    expect(daysUntil('2026-08-18T00:00:00.000Z', now)).toBe(-7);
  });
});

describe('pluralize', () => {
  it('uses the singular for exactly one', () => {
    expect(pluralize(1, 'invoice')).toBe('1 invoice');
  });

  it('uses the plural otherwise', () => {
    expect(pluralize(0, 'invoice')).toBe('0 invoices');
    expect(pluralize(3, 'invoice')).toBe('3 invoices');
  });

  it('accepts an irregular plural', () => {
    expect(pluralize(2, 'company', 'companies')).toBe('2 companies');
  });
});

describe('humanizeStatus', () => {
  it('turns a screaming snake status into a sentence', () => {
    expect(humanizeStatus('PAST_DUE')).toBe('Past due');
    expect(humanizeStatus('ACTIVE')).toBe('Active');
    expect(humanizeStatus('VOID')).toBe('Void');
  });
});

describe('initialsFor', () => {
  it('takes the first letter of the first two name parts', () => {
    expect(initialsFor('Ada Lovelace', 'ada@test.com')).toBe('AL');
    expect(initialsFor('Ada Byron Lovelace', 'ada@test.com')).toBe('AB');
  });

  it('falls back to the email local part when there is no name', () => {
    expect(initialsFor(null, 'ada.lovelace@test.com')).toBe('AL');
    expect(initialsFor('   ', 'ada@test.com')).toBe('A');
  });
});
