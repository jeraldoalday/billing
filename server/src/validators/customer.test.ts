import { describe, expect, it } from 'vitest';
import { createCustomerSchema, updateCustomerSchema } from './customer';

describe('createCustomerSchema', () => {
  it('accepts a normal customer', () => {
    const result = createCustomerSchema.safeParse({ name: 'Jane Doe', email: 'jane@example.com' });
    expect(result.success).toBe(true);
  });

  it('rejects an email longer than RFC 5321 allows', () => {
    const tooLong = `${'a'.repeat(250)}@b.co`;
    const result = createCustomerSchema.safeParse({ name: 'Jane Doe', email: tooLong });
    expect(result.success).toBe(false);
  });
});

describe('updateCustomerSchema', () => {
  it('rejects an email longer than RFC 5321 allows', () => {
    const tooLong = `${'a'.repeat(250)}@b.co`;
    const result = updateCustomerSchema.safeParse({ email: tooLong });
    expect(result.success).toBe(false);
  });
});
