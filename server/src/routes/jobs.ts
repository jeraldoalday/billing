import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as billingService from '../services/billing.service';
import * as jobService from '../services/job.service';
import { runBillingCycleSchema } from '../validators/billing';
import { enqueueJobSchema, listJobRunsQuerySchema, runDueJobsSchema } from '../validators/job';

export const jobsRouter = Router();

jobsRouter.use(requireAuth);

// The durable history: what the worker (or an operator) has run for this
// organization, newest first.
jobsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listJobRunsQuerySchema.parse(req.query);
    const runs = await jobService.listJobRuns(req.auth.orgId, query);
    res.json({ runs });
  } catch (err) {
    next(err);
  }
});

// A live view of the in-process queue. Declared before `/:id` so the
// literal path isn't swallowed by the id parameter.
jobsRouter.get('/queue', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    res.json({ queue: jobService.describeQueue() });
  } catch (err) {
    next(err);
  }
});

// Queues one job. 202, not 201: the response is an acknowledgement that the
// work is scheduled, and the row it points at is not its result yet.
jobsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = enqueueJobSchema.parse(req.body ?? {});
    const run = await jobService.enqueueJob(req.auth.orgId, input);
    res.status(202).json({ run });
  } catch (err) {
    next(err);
  }
});

// Runs this organization's due jobs now instead of waiting for the worker's
// next tick — what an operator reaches for after fixing whatever made the
// last sweep fail.
jobsRouter.post('/run', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = runDueJobsSchema.parse(req.body ?? {});
    const result = await jobService.runDueJobs(req.auth.orgId, input);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Runs a billing cycle in the request itself and answers with the full
// summary, rather than queueing one and answering with a job id. Both are
// useful: this is the one to reach for when you want to see exactly what a
// run would do (with `asOf`, or scoped to one subscription), the queue is
// the one to use for a sweep nobody is waiting on.
jobsRouter.post('/billing-run', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = runBillingCycleSchema.parse(req.body ?? {});
    const summary = await billingService.runBillingCycle(req.auth.orgId, input);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const run = await jobService.getJobRun(req.auth.orgId, req.params.id);
    res.json({ run });
  } catch (err) {
    next(err);
  }
});
