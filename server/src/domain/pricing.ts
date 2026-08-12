// SQLite has no native enum type (see prisma/schema.prisma), so Plan's
// `pricingModel` and `interval` columns are plain strings. These tuples are
// the single source of truth for the valid values, consumed by Zod schemas
// (z.enum) and anywhere else that needs the allowed set at runtime.

export const PRICING_MODELS = ['FLAT', 'TIERED', 'USAGE'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const BILLING_INTERVALS = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
