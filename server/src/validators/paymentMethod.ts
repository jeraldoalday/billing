import { z } from 'zod';
import { isValidLuhn } from '../domain/card';

export const createPaymentMethodSchema = z.object({
  customerId: z.string().min(1),
  // Accepted only long enough to derive brand/last4/tokenize — never
  // persisted (see prisma/schema.prisma PaymentMethod). The Luhn check
  // catches a mistyped digit up front, the same way a real card issuer
  // would reject it, instead of silently tokenizing a number that can
  // never belong to a real card.
  cardNumber: z
    .string()
    .regex(/^\d{13,19}$/, 'cardNumber must be 13-19 digits')
    .refine(isValidLuhn, 'cardNumber fails the Luhn checksum'),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2000).max(2100),
  isDefault: z.boolean().optional(),
});
export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodSchema>;

export const listPaymentMethodsQuerySchema = z.object({
  customerId: z.string().min(1).optional(),
});
export type ListPaymentMethodsQuery = z.infer<typeof listPaymentMethodsQuerySchema>;
