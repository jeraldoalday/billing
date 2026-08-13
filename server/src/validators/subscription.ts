import { z } from 'zod';
import { SUBSCRIPTION_STATUSES } from '../domain/subscription';

export const createSubscriptionSchema = z.object({
  customerId: z.string().min(1),
  planId: z.string().min(1),
  // Number of days the subscription starts in TRIALING before its first
  // billing period begins. Omitted (or 0) means it starts ACTIVE immediately.
  trialDays: z.number().int().positive().max(365).optional(),
});
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;

export const cancelSubscriptionSchema = z.object({
  // false (default): cancel immediately. true: keep billing through the end
  // of the current period and cancel then (actually flipping the status to
  // CANCELED at that point is the recurring billing runner's job — Day 10).
  atPeriodEnd: z.boolean().optional().default(false),
});
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;

export const changeSubscriptionPlanSchema = z.object({
  planId: z.string().min(1),
});
export type ChangeSubscriptionPlanInput = z.infer<typeof changeSubscriptionPlanSchema>;

export const listSubscriptionsQuerySchema = z.object({
  customerId: z.string().min(1).optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
});
export type ListSubscriptionsQuery = z.infer<typeof listSubscriptionsQuerySchema>;
