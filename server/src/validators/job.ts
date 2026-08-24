import { z } from 'zod';
import { JOB_NAMES, JOB_STATUSES } from '../domain/job';

// A job's payload is whatever its handler needs; `organizationId` is never
// accepted from the caller (it comes from the authenticated token, like
// every other org-scoped write in this codebase) and is attached by
// src/services/job.service.ts.
export const enqueueJobSchema = z.object({
  name: z.enum(JOB_NAMES),
  payload: z
    .object({
      // Run the sweep as if it were a later instant, for the same reason
      // src/validators/dunning.ts accepts one.
      asOf: z.coerce.date().optional(),
      limit: z.coerce.number().int().positive().max(500).optional(),
      subscriptionId: z.string().min(1).optional(),
    })
    .default({}),
  runAt: z.coerce.date().optional(),
  maxAttempts: z.coerce.number().int().positive().max(10).optional(),
});
export type EnqueueJobInput = z.infer<typeof enqueueJobSchema>;

export const listJobRunsQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  name: z.enum(JOB_NAMES).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type ListJobRunsQuery = z.infer<typeof listJobRunsQuerySchema>;

export const runDueJobsSchema = z.object({
  asOf: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
});
export type RunDueJobsInput = z.infer<typeof runDueJobsSchema>;
