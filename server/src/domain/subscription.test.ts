import { describe, expect, it } from 'vitest';
import { addInterval } from './subscription';

describe('addInterval', () => {
  it('adds a day', () => {
    const result = addInterval(new Date('2026-01-01T12:00:00.000Z'), 'DAY');
    expect(result.toISOString()).toBe('2026-01-02T12:00:00.000Z');
  });

  it('adds a week', () => {
    const result = addInterval(new Date('2026-01-01T00:00:00.000Z'), 'WEEK');
    expect(result.toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });

  it('adds a month, preserving the day of month', () => {
    const result = addInterval(new Date('2026-01-15T00:00:00.000Z'), 'MONTH');
    expect(result.toISOString()).toBe('2026-02-15T00:00:00.000Z');
  });

  it('adds a year', () => {
    const result = addInterval(new Date('2026-01-15T00:00:00.000Z'), 'YEAR');
    expect(result.toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('clamps end-of-month overflow instead of rolling into the next month', () => {
    // Jan 31 + 1 month: February only has 28 days in 2026 (not a leap year).
    const result = addInterval(new Date('2026-01-31T00:00:00.000Z'), 'MONTH');
    expect(result.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('clamps end-of-month overflow across a leap year', () => {
    const result = addInterval(new Date('2027-01-31T00:00:00.000Z'), 'MONTH');
    // 2028 is a leap year, but we're adding a month within 2027.
    expect(result.toISOString()).toBe('2027-02-28T00:00:00.000Z');

    const leapResult = addInterval(new Date('2028-01-31T00:00:00.000Z'), 'MONTH');
    expect(leapResult.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('supports a count greater than 1', () => {
    const result = addInterval(new Date('2026-01-01T00:00:00.000Z'), 'MONTH', 3);
    expect(result.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rolls a month addition over a year boundary', () => {
    const result = addInterval(new Date('2026-12-15T00:00:00.000Z'), 'MONTH');
    expect(result.toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
});
