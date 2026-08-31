import { describe, expect, it } from 'vitest';
import { activeLabel, activeTone, statusTone } from './status';

describe('statusTone', () => {
  it('colours a healthy status as success', () => {
    expect(statusTone('ACTIVE')).toBe('success');
    expect(statusTone('PAID')).toBe('success');
    expect(statusTone('SUCCEEDED')).toBe('success');
  });

  it('colours a status that needs attention distinctly from one that failed', () => {
    expect(statusTone('PAST_DUE')).toBe('warning');
    expect(statusTone('FAILED')).toBe('danger');
    expect(statusTone('PAST_DUE')).not.toBe(statusTone('FAILED'));
  });

  // A canceled subscription is an outcome, not an error; showing it in red
  // would have every churned row shouting for attention it does not need.
  it('treats end states as neutral rather than as failures', () => {
    expect(statusTone('CANCELED')).toBe('neutral');
    expect(statusTone('VOID')).toBe('neutral');
    expect(statusTone('DRAFT')).toBe('neutral');
  });

  it('accepts a status in either case', () => {
    expect(statusTone('active')).toBe(statusTone('ACTIVE'));
  });

  it('falls back to neutral for a status it has never seen', () => {
    expect(statusTone('SOMETHING_NEW')).toBe('neutral');
  });
});

describe('activeTone', () => {
  it('distinguishes a live row from an archived one', () => {
    expect(activeTone(true)).toBe('success');
    expect(activeTone(false)).toBe('neutral');
    expect(activeLabel(true)).toBe('Active');
    expect(activeLabel(false)).toBe('Archived');
  });
});
