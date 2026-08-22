import { describe, expect, it } from 'vitest';
import {
  canTransitionInvoiceStatus,
  composeInvoiceAmounts,
  formatInvoiceNumber,
  sumLineItemAmounts,
} from './invoice';

describe('canTransitionInvoiceStatus', () => {
  it('allows DRAFT to move to OPEN or VOID', () => {
    expect(canTransitionInvoiceStatus('DRAFT', 'OPEN')).toBe(true);
    expect(canTransitionInvoiceStatus('DRAFT', 'VOID')).toBe(true);
  });

  it('allows OPEN to move to PAID or VOID', () => {
    expect(canTransitionInvoiceStatus('OPEN', 'PAID')).toBe(true);
    expect(canTransitionInvoiceStatus('OPEN', 'VOID')).toBe(true);
  });

  it('rejects skipping straight from DRAFT to PAID', () => {
    expect(canTransitionInvoiceStatus('DRAFT', 'PAID')).toBe(false);
  });

  it('treats PAID as terminal', () => {
    expect(canTransitionInvoiceStatus('PAID', 'OPEN')).toBe(false);
    expect(canTransitionInvoiceStatus('PAID', 'VOID')).toBe(false);
    expect(canTransitionInvoiceStatus('PAID', 'DRAFT')).toBe(false);
  });

  it('treats VOID as terminal', () => {
    expect(canTransitionInvoiceStatus('VOID', 'OPEN')).toBe(false);
    expect(canTransitionInvoiceStatus('VOID', 'PAID')).toBe(false);
    expect(canTransitionInvoiceStatus('VOID', 'DRAFT')).toBe(false);
  });

  it('rejects a no-op transition to the same status', () => {
    expect(canTransitionInvoiceStatus('OPEN', 'OPEN')).toBe(false);
  });
});

describe('sumLineItemAmounts', () => {
  it('sums positive amounts', () => {
    expect(sumLineItemAmounts([{ amount: 2900 }, { amount: 500 }])).toBe(3400);
  });

  it('nets out a negative proration credit against a positive charge', () => {
    expect(sumLineItemAmounts([{ amount: 2900 }, { amount: -1200 }])).toBe(1700);
  });

  it('returns 0 for no line items', () => {
    expect(sumLineItemAmounts([])).toBe(0);
  });
});

describe('formatInvoiceNumber', () => {
  it('zero-pads to 6 digits', () => {
    expect(formatInvoiceNumber(1)).toBe('INV-000001');
    expect(formatInvoiceNumber(42)).toBe('INV-000042');
  });

  it('grows past the padding instead of truncating', () => {
    expect(formatInvoiceNumber(1234567)).toBe('INV-1234567');
  });

  it('rejects a non-positive sequence', () => {
    expect(() => formatInvoiceNumber(0)).toThrow();
    expect(() => formatInvoiceNumber(-1)).toThrow();
  });
});

describe('composeInvoiceAmounts', () => {
  it('totals an undiscounted invoice as subtotal plus tax', () => {
    expect(composeInvoiceAmounts({ subtotal: 10000, discountAmount: 0, taxAmount: 2000 })).toEqual({
      subtotal: 10000,
      discountAmount: 0,
      taxAmount: 2000,
      taxableAmount: 10000,
      total: 12000,
    });
  });

  it('takes the discount off before the tax is added', () => {
    const amounts = composeInvoiceAmounts({ subtotal: 10000, discountAmount: 2500, taxAmount: 1500 });

    expect(amounts.taxableAmount).toBe(7500);
    expect(amounts.total).toBe(9000);
  });

  it('totals a fully discounted invoice at zero', () => {
    const amounts = composeInvoiceAmounts({ subtotal: 4999, discountAmount: 4999, taxAmount: 0 });

    expect(amounts.taxableAmount).toBe(0);
    expect(amounts.total).toBe(0);
  });

  it('carries a credit through as a negative total', () => {
    const amounts = composeInvoiceAmounts({ subtotal: -2000, discountAmount: 0, taxAmount: -400 });

    expect(amounts.total).toBe(-2400);
  });
});
