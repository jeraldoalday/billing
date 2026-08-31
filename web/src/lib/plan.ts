import type { BillingInterval, Plan, PriceTier, PricingModel, Product } from '../api/types';
import { formatMoney } from './format';

/**
 * Saying out loud what a plan charges.
 *
 * A plan's price lives across four nullable columns — `flatAmount`,
 * `usageMetric`, `usageUnitAmount`, `tiers` — of which a different subset
 * is set for each pricing model. Rather than let every table cell rebuild
 * that logic (and get the TIERED case subtly wrong), each shape is turned
 * into a sentence here, once.
 */

/** The intervals the API accepts, in the order a plan form should offer them. */
export const BILLING_INTERVALS: readonly BillingInterval[] = ['DAY', 'WEEK', 'MONTH', 'YEAR'];

export const PRICING_MODELS: readonly PricingModel[] = ['FLAT', 'USAGE', 'TIERED'];

const INTERVAL_NOUNS: Record<BillingInterval, string> = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
};

const PRICING_MODEL_LABELS: Record<PricingModel, string> = {
  FLAT: 'Flat',
  USAGE: 'Usage',
  TIERED: 'Tiered',
};

const PRICING_MODEL_HINTS: Record<PricingModel, string> = {
  FLAT: 'One fixed amount every billing period.',
  USAGE: 'Every recorded unit costs the same amount.',
  TIERED: 'The unit price changes as usage crosses each tier.',
};

/** `MONTH` as the noun a price is quoted against: "$19.99 / month". */
export function formatInterval(interval: BillingInterval): string {
  return INTERVAL_NOUNS[interval] ?? interval.toLowerCase();
}

export function formatPricingModel(model: PricingModel): string {
  return PRICING_MODEL_LABELS[model] ?? model;
}

/** One line of guidance under the pricing-model picker in the plan form. */
export function describePricingModel(model: PricingModel): string {
  return PRICING_MODEL_HINTS[model] ?? '';
}

const counts = new Intl.NumberFormat('en-US');

/**
 * What a plan charges, in one line.
 *
 * A metered plan has no single price, so it is described by its rate and
 * the metric it counts instead of being shown as a blank cell — which is
 * what reading `flatAmount` alone would produce for two of the three
 * pricing models.
 */
export function describePlanPrice(plan: Plan): string {
  const per = formatInterval(plan.interval);

  switch (plan.pricingModel) {
    case 'FLAT':
      return plan.flatAmount === null
        ? 'No price set'
        : `${formatMoney(plan.flatAmount, plan.currency)} / ${per}`;

    case 'USAGE':
      return plan.usageUnitAmount === null
        ? `Metered on ${plan.usageMetric ?? 'usage'}`
        : `${formatMoney(plan.usageUnitAmount, plan.currency)} per ${plan.usageMetric ?? 'unit'}`;

    case 'TIERED': {
      const tiers = plan.tiers ?? [];
      const metric = plan.usageMetric ?? 'usage';
      return tiers.length === 0
        ? `Tiered on ${metric}`
        : `Tiered on ${metric} · ${counts.format(tiers.length)} tier${tiers.length === 1 ? '' : 's'}`;
    }

    default:
      return '—';
  }
}

/**
 * The usage band a tier covers, e.g. `1 – 1,000` or `1,001 and above`.
 *
 * `upTo` is the inclusive top of the band and the bottom is implied by the
 * tier before it, so a row cannot describe itself — the previous bound has
 * to be passed in.
 */
export function describeTierRange(tier: PriceTier, previousUpTo: number): string {
  const from = counts.format(previousUpTo + 1);
  if (tier.upTo === null) {
    return `${from} and above`;
  }
  return `${from} – ${counts.format(tier.upTo)}`;
}

/** What a tier charges within its band, including any flat fee. */
export function describeTierRate(tier: PriceTier, currency: string): string {
  const unit = `${formatMoney(tier.unitAmount, currency)} each`;
  return tier.flatFee > 0 ? `${unit} + ${formatMoney(tier.flatFee, currency)} flat` : unit;
}

export interface DescribedTier {
  tier: PriceTier;
  range: string;
  rate: string;
}

/** Every tier of a plan, each already carrying its own band and rate. */
export function describeTiers(plan: Plan): DescribedTier[] {
  const tiers = plan.tiers ?? [];
  let previousUpTo = 0;

  return tiers.map((tier) => {
    const described = {
      tier,
      range: describeTierRange(tier, previousUpTo),
      rate: describeTierRate(tier, plan.currency),
    };
    // Only a bounded tier moves the floor; the unbounded final tier is last
    // by construction, so nothing reads the floor after it.
    if (tier.upTo !== null) {
      previousUpTo = tier.upTo;
    }
    return described;
  });
}

export interface PlanGroup {
  productId: string;
  productName: string;
  productDescription: string | null;
  productActive: boolean;
  plans: Plan[];
}

/**
 * Plans arranged under the product they price, which is how the catalogue
 * reads to a person: a product with two or three plans on it, not a flat
 * list of names whose relationship you have to infer.
 *
 * Products with no plans are kept — an empty product is exactly the state
 * where someone needs to be shown the "add a plan" affordance. A plan whose
 * product is missing from the list (archived, filtered out) is kept too,
 * under a placeholder, because silently dropping a priced plan would be
 * worse than showing it with a vague heading.
 */
export function groupPlansByProduct(plans: Plan[], products: Product[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();

  for (const product of products) {
    groups.set(product.id, {
      productId: product.id,
      productName: product.name,
      productDescription: product.description,
      productActive: product.active,
      plans: [],
    });
  }

  for (const plan of plans) {
    let group = groups.get(plan.productId);
    if (!group) {
      group = {
        productId: plan.productId,
        productName: 'Unknown product',
        productDescription: null,
        productActive: true,
        plans: [],
      };
      groups.set(plan.productId, group);
    }
    group.plans.push(plan);
  }

  return [...groups.values()];
}
