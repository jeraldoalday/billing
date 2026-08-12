import { z } from 'zod';
import { BILLING_INTERVALS } from '../domain/pricing';

const currencySchema = z.string().trim().toLowerCase().length(3, 'currency must be a 3-letter ISO 4217 code');

const priceTierSchema = z.object({
  // Inclusive upper bound of usage quantity billed at unitAmount within this
  // tier. null marks the final, unbounded ("and above") tier.
  upTo: z.number().int().positive().nullable(),
  unitAmount: z.number().int().nonnegative(),
  flatFee: z.number().int().nonnegative().optional().default(0),
});
export type PriceTierInput = z.infer<typeof priceTierSchema>;

// Tiers must be given in ascending order, each `upTo` strictly greater than
// the one before it, and only the final tier may be unbounded (upTo: null)
// to represent "this rate and above". Returns an error message, or null if
// the tiers are well-formed. Exported (rather than inlined in a refine) so
// it's directly unit-testable.
export function validateTierOrdering(tiers: PriceTierInput[]): string | null {
  if (tiers.length === 0) {
    return 'At least one tier is required';
  }

  let previousUpTo = 0;
  for (const [index, tier] of tiers.entries()) {
    const isLast = index === tiers.length - 1;

    if (tier.upTo === null) {
      if (!isLast) {
        return `Tier ${index} is unbounded (upTo: null) but is not the last tier`;
      }
      continue;
    }

    if (tier.upTo <= previousUpTo) {
      return `Tier ${index}'s upTo (${tier.upTo}) must be greater than the previous tier's upTo (${previousUpTo})`;
    }
    previousUpTo = tier.upTo;
  }

  return null;
}

const basePlanFields = {
  productId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  interval: z.enum(BILLING_INTERVALS),
  currency: currencySchema.default('usd'),
  active: z.boolean().optional(),
};

const flatPlanSchema = z.object({
  ...basePlanFields,
  pricingModel: z.literal('FLAT'),
  flatAmount: z.number().int().positive(),
});

const usagePlanSchema = z.object({
  ...basePlanFields,
  pricingModel: z.literal('USAGE'),
  usageMetric: z.string().trim().min(1).max(100),
  usageUnitAmount: z.number().int().nonnegative(),
});

const tieredPlanSchema = z.object({
  ...basePlanFields,
  pricingModel: z.literal('TIERED'),
  usageMetric: z.string().trim().min(1).max(100),
  tiers: z.array(priceTierSchema).min(1).max(20),
});

export const createPlanSchema = z
  .discriminatedUnion('pricingModel', [flatPlanSchema, usagePlanSchema, tieredPlanSchema])
  .superRefine((data, ctx) => {
    if (data.pricingModel === 'TIERED') {
      const error = validateTierOrdering(data.tiers);
      if (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: error, path: ['tiers'] });
      }
    }
  });
export type CreatePlanInput = z.infer<typeof createPlanSchema>;

// Prices are immutable once created, mirroring how most billing systems
// treat prices: subscriptions and invoices come to reference a plan's
// pricing, so letting pricingModel/amounts change out from under them would
// silently alter what customers are charged. To reprice, create a new Plan
// and archive (active: false) the old one. Updates may only touch
// descriptive/lifecycle fields.
export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const listPlansQuerySchema = z.object({
  productId: z.string().min(1).optional(),
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;
