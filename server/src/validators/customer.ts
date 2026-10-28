import { z } from 'zod';

// ISO 3166-1 alpha-2 tax jurisdiction, consumed by src/domain/tax.ts when
// generating an invoice. Stored uppercase regardless of input case.
const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(2, 'country must be a 2-letter ISO 3166-1 alpha-2 code');

// A VAT/GST registration number. Stored normalized (uppercase, no spaces or
// dashes) so the reverse-charge check in src/domain/tax.ts sees the same
// string however the customer typed it. Only the shape is validated here —
// see isVatIdShapeValid for why we don't claim to know it's registered.
const taxIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(z.string().min(4, 'taxId must be a country-prefixed registration number').max(20));

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  // 254 is RFC 5321's own limit on a full address — the same length cap
  // every other string field here already has, which email alone was
  // missing.
  email: z.string().trim().toLowerCase().email().max(254),
  active: z.boolean().optional(),
  country: countrySchema.optional(),
  taxId: taxIdSchema.optional(),
  taxExempt: z.boolean().optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    active: z.boolean().optional(),
    country: countrySchema.nullable().optional(),
    // Nullable so a customer who deregisters or loses their exemption can
    // have the field cleared, not just overwritten.
    taxId: taxIdSchema.nullable().optional(),
    taxExempt: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const listCustomersQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  email: z.string().trim().toLowerCase().optional(),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;
