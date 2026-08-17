import { z } from 'zod';

export const recordUsageEventSchema = z.object({
  subscriptionId: z.string().min(1),
  metric: z.string().trim().min(1).max(100),
  quantity: z.number().int().positive(),
  // When the usage actually occurred, not when it's reported — usage is
  // often ingested after the fact (e.g. a nightly batch of yesterday's API
  // calls). Defaults to ingestion time when omitted.
  timestamp: z.coerce.date().optional(),
  // Lets a caller safely resend the same ingestion request (e.g. after a
  // network timeout) without double-counting: a duplicate key for the same
  // subscription is rejected with a 409 rather than creating a second event.
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});
export type RecordUsageEventInput = z.infer<typeof recordUsageEventSchema>;

export const listUsageEventsQuerySchema = z
  .object({
    subscriptionId: z.string().min(1).optional(),
    customerId: z.string().min(1).optional(),
    metric: z.string().min(1).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });
export type ListUsageEventsQuery = z.infer<typeof listUsageEventsQuerySchema>;
