import { z } from 'zod';

// How far back a report window reaches when the caller doesn't say. Thirty
// days rather than a calendar month so the default is the same length
// whenever it's asked for, which matters for a rate that's compared between
// runs.
const DEFAULT_WINDOW_DAYS = 30;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// A closed-open window [from, to). Defaults to the last 30 days ending now.
// `to` is exclusive so consecutive windows tile without counting the same
// cancellation or payment twice, matching how every other period boundary
// in this codebase works.
export const reportWindowQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .transform((query) => ({
    from: query.from ?? daysAgo(DEFAULT_WINDOW_DAYS),
    to: query.to ?? new Date(),
  }))
  .refine((query) => query.from < query.to, {
    message: '`from` must be before `to`',
    path: ['from'],
  });
export type ReportWindowQuery = z.infer<typeof reportWindowQuerySchema>;

// What an MRR breakdown is grouped by. Plan is the default because it's the
// question people actually ask of an MRR figure ("which plans is this
// coming from"); interval and currency answer the two other common ones.
export const MRR_GROUPINGS = ['plan', 'interval', 'currency'] as const;
export type MrrGrouping = (typeof MRR_GROUPINGS)[number];

export const mrrQuerySchema = z.object({
  groupBy: z.enum(MRR_GROUPINGS).default('plan'),
});
export type MrrQuery = z.infer<typeof mrrQuerySchema>;
