// Pure pricing math for USAGE and TIERED plans (see src/domain/pricing.ts).
// No I/O, no Prisma types — takes plain values so it's trivially unit
// testable and reusable from both invoice generation
// (src/services/invoice.service.ts) and anywhere else that needs to preview
// a charge for a given quantity. Amounts are integer minor currency units
// (e.g. cents), matching every other amount in this codebase.

export interface UsageTier {
  /** Ascending band order, starting at 0. Matches PriceTier.order. */
  order: number;
  /** Inclusive upper bound of usage quantity billed at unitAmount within this band. null marks the final, unbounded tier. */
  upTo: number | null;
  unitAmount: number;
  /** One-time fee added if any quantity falls into this tier. */
  flatFee: number;
}

// Graduated tiering: usage is billed cumulatively across bands, cheapest
// band first. For a quantity of 150 against tiers [0-100 @ $1, 100+ @ $0.50],
// the first 100 units cost $100 and the remaining 50 cost $25, for $125
// total — not simply 150 * the band the 150th unit falls into. A tier's
// flatFee is added once, only if some quantity was actually billed within
// that tier. Tiers must already be sorted ascending by `order` (see
// src/services/plan.service.ts's TIERS_ORDERED).
export function calculateTieredAmount(quantity: number, tiers: readonly UsageTier[]): number {
  if (quantity <= 0) {
    return 0;
  }
  if (tiers.length === 0) {
    throw new Error('At least one tier is required to price usage');
  }

  let remaining = quantity;
  let previousUpTo = 0;
  let total = 0;

  for (const tier of [...tiers].sort((a, b) => a.order - b.order)) {
    if (remaining <= 0) {
      break;
    }

    const bandWidth = tier.upTo === null ? remaining : tier.upTo - previousUpTo;
    const quantityInBand = Math.min(remaining, bandWidth);

    if (quantityInBand > 0) {
      total += quantityInBand * tier.unitAmount + tier.flatFee;
      remaining -= quantityInBand;
    }

    previousUpTo = tier.upTo ?? previousUpTo;
  }

  return total;
}

// The amount owed for a period's metered consumption, dispatching on the
// plan's pricing model. FLAT plans have no usage component (their fixed
// price is handled separately by src/domain/proration.ts's
// periodAmountForProration), so callers should only reach here for
// USAGE/TIERED plans — passing a FLAT plan is treated as a programmer error.
export function calculateUsageAmount(
  plan: { pricingModel: string; usageUnitAmount: number | null },
  tiers: readonly UsageTier[],
  quantity: number,
): number {
  if (plan.pricingModel === 'USAGE') {
    return quantity > 0 ? quantity * (plan.usageUnitAmount ?? 0) : 0;
  }
  if (plan.pricingModel === 'TIERED') {
    return calculateTieredAmount(quantity, tiers);
  }
  throw new Error(`calculateUsageAmount does not apply to pricing model ${plan.pricingModel}`);
}
