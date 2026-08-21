import { z } from 'zod';
import { DUNNING_STATUSES } from '../domain/dunning';

export const listDunningCampaignsQuerySchema = z.object({
  status: z.enum(DUNNING_STATUSES).optional(),
  subscriptionId: z.string().min(1).optional(),
  invoiceId: z.string().min(1).optional(),
});
export type ListDunningCampaignsQuery = z.infer<typeof listDunningCampaignsQuerySchema>;

export const runDunningSchema = z.object({
  // Lets an operator (or a test) run the sweep as if it were a later
  // instant, so a schedule measured in days can be exercised without
  // waiting days. Defaults to the real clock.
  asOf: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type RunDunningInput = z.infer<typeof runDunningSchema>;
