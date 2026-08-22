import { z } from 'zod';
import { COUPON_DURATIONS, COUPON_REDEMPTION_STATUSES, COUPON_TYPES } from '../domain/coupon';

// The customer-facing code typed at checkout. Normalized to uppercase so
// `SAVE20` and `save20` are the same coupon — the unique index on
// (organizationId, code) is case-sensitive, and letting both exist would
// make which one applied depend on how it was typed.
const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(40)
  .regex(/^[A-Z0-9_-]+$/, 'code may only contain letters, digits, hyphens and underscores');

// PERCENT_OFF carries `percentOff` (whole percent, 1-100 — 100 means the
// invoice is free), AMOUNT_OFF carries `amountOff` in minor currency units
// plus the `currency` those units are in. Cross-field validation rejects the
// mismatched combinations up front so the service never has to defend
// against a coupon that says PERCENT_OFF but only has an amount on file.
export const createCouponSchema = z
  .object({
    code: codeSchema,
    name: z.string().trim().min(1).max(200).optional(),
    type: z.enum(COUPON_TYPES),
    percentOff: z.number().int().min(1).max(100).optional(),
    amountOff: z.number().int().positive().optional(),
    currency: z.string().trim().toLowerCase().length(3).optional(),
    duration: z.enum(COUPON_DURATIONS),
    durationInMonths: z.number().int().positive().max(120).optional(),
    maxRedemptions: z.number().int().positive().optional(),
    redeemBy: z.coerce.date().optional(),
    active: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.type === 'PERCENT_OFF') {
      if (input.percentOff === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'percentOff is required for a PERCENT_OFF coupon',
          path: ['percentOff'],
        });
      }
      if (input.amountOff !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'amountOff is only valid for an AMOUNT_OFF coupon',
          path: ['amountOff'],
        });
      }
    }

    if (input.type === 'AMOUNT_OFF') {
      if (input.amountOff === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'amountOff is required for an AMOUNT_OFF coupon',
          path: ['amountOff'],
        });
      }
      // Without a currency an amount-off coupon can't tell whether it may
      // be applied to a given invoice (see couponMatchesCurrency), so it's
      // required rather than defaulted — guessing "usd" would quietly
      // discount euro invoices at the wrong rate.
      if (!input.currency) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'currency is required for an AMOUNT_OFF coupon',
          path: ['currency'],
        });
      }
      if (input.percentOff !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'percentOff is only valid for a PERCENT_OFF coupon',
          path: ['percentOff'],
        });
      }
    }

    if (input.duration === 'REPEATING' && input.durationInMonths === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'durationInMonths is required for a REPEATING coupon',
        path: ['durationInMonths'],
      });
    }

    if (input.duration !== 'REPEATING' && input.durationInMonths !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'durationInMonths is only valid for a REPEATING coupon',
        path: ['durationInMonths'],
      });
    }
  });
export type CreateCouponInput = z.infer<typeof createCouponSchema>;

// Only the fields that can change without invalidating redemptions already
// made: how the offer is presented, how long it stays open, and whether it
// is still open at all. The discount itself (type/amount/duration) is
// immutable — a customer who redeemed 20% off keeps 20% off, and editing it
// in place would silently rewrite what every existing redemption is worth.
export const updateCouponSchema = z
  .object({
    name: z.string().trim().min(1).max(200).nullable().optional(),
    maxRedemptions: z.number().int().positive().nullable().optional(),
    redeemBy: z.coerce.date().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;

export const listCouponsQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  code: codeSchema.optional(),
  duration: z.enum(COUPON_DURATIONS).optional(),
});
export type ListCouponsQuery = z.infer<typeof listCouponsQuerySchema>;

// A coupon is redeemed by code rather than by id: the code is what a
// customer is given and what an operator types, and an org's codes are
// unique, so requiring the id would just mean looking it up first.
export const redeemCouponSchema = z.object({
  code: codeSchema,
});
export type RedeemCouponInput = z.infer<typeof redeemCouponSchema>;

export const listRedemptionsQuerySchema = z.object({
  status: z.enum(COUPON_REDEMPTION_STATUSES).optional(),
  couponId: z.string().min(1).optional(),
  subscriptionId: z.string().min(1).optional(),
});
export type ListRedemptionsQuery = z.infer<typeof listRedemptionsQuerySchema>;
