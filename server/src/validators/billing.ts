import { z } from 'zod';

// How many periods one pass will bill for a single subscription before
// moving on. A subscription is normally at most one period behind; the
// bound exists so a row with a corrupt period (or a worker that has been
// down for months) catches up over several runs instead of holding the
// whole sweep on one customer.
const DEFAULT_MAX_PERIODS_PER_SUBSCRIPTION = 12;

export const runBillingCycleSchema = z.object({
  // Lets an operator (or a test) run the cycle as if it were a later
  // instant, so a schedule measured in months can be exercised without
  // waiting months. Defaults to the real clock, exactly like
  // src/validators/dunning.ts's `asOf`.
  asOf: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  // Bills one named subscription instead of sweeping the organization —
  // what support reaches for when a single customer's renewal needs
  // pushing through.
  subscriptionId: z.string().min(1).optional(),
  maxPeriodsPerSubscription: z.coerce
    .number()
    .int()
    .positive()
    .max(60)
    .default(DEFAULT_MAX_PERIODS_PER_SUBSCRIPTION),
});
export type RunBillingCycleInput = z.infer<typeof runBillingCycleSchema>;
