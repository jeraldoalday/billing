import { describe, expect, it } from 'vitest';
import { createPaymentMethodSchema } from './paymentMethod';

const base = { customerId: 'cust_1', expMonth: 12, expYear: 2030 };

describe('createPaymentMethodSchema', () => {
  it('accepts a cardNumber that passes the Luhn checksum', () => {
    const result = createPaymentMethodSchema.safeParse({ ...base, cardNumber: '4242424242424242' });
    expect(result.success).toBe(true);
  });

  it('rejects a cardNumber with a single mistyped digit', () => {
    // Same digits as the accepted number above but for a transposed 1/2,
    // which still matches the 13-19 digit shape but fails the checksum —
    // the typo a Luhn check exists to catch.
    const result = createPaymentMethodSchema.safeParse({ ...base, cardNumber: '4242424242424241' });
    expect(result.success).toBe(false);
  });

  it('rejects a cardNumber that is not 13-19 digits before the Luhn check even runs', () => {
    const result = createPaymentMethodSchema.safeParse({ ...base, cardNumber: '123' });
    expect(result.success).toBe(false);
  });
});
