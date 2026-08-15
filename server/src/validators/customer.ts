import { z } from 'zod';

// ISO 3166-1 alpha-2 tax jurisdiction, consumed by src/domain/tax.ts when
// generating an invoice. Stored uppercase regardless of input case.
const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(2, 'country must be a 2-letter ISO 3166-1 alpha-2 code');

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  active: z.boolean().optional(),
  country: countrySchema.optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    active: z.boolean().optional(),
    country: countrySchema.nullable().optional(),
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
