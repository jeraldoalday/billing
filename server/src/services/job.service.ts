import { ApiError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { InMemoryJobQueue, type JobEvent, type JobRecord } from '../lib/jobQueue';
import { DEFAULT_MAX_JOB_ATTEMPTS, JOB_NAMES, type JobName } from '../domain/job';
import * as billingService from './billing.service';
import * as dunningService from './dunning.service';
import * as webhookService from './webhook.service';
import type { EnqueueJobInput, ListJobRunsQuery, RunDueJobsInput } from '../validators/job';

// The application's job runtime: the one queue every background sweep runs
// through, the handlers registered on it, and the JobRun rows that make
// what it did visible afterwards.
//
// The queue itself (src/lib/jobQueue.ts) knows nothing about tenants or
// Prisma. This module is what ties the two together: every payload carries
// an `organizationId`, which is what the JobRun row is scoped to and what
// an org-scoped sweep filters on.

const DEFAULT_BILLING_LIMIT = 100;
const DEFAULT_SWEEP_LIMIT = 50;
const MAX_PERIODS_PER_SUBSCRIPTION = 12;
// A result larger than this is a summary that has stopped being a summary.
// Rather than truncate it into invalid JSON, the row records that it was
// dropped — the detail is always reconstructable from the invoices,
// campaigns or deliveries the job acted on.
const MAX_SERIALIZED_RESULT_LENGTH = 20_000;

export interface JobPayload {
  organizationId: string;
  /** ISO-8601: a payload is persisted as JSON, so it can't carry a Date. */
  asOf?: string;
  limit?: number;
  subscriptionId?: string;
}

function instantFor(payload: JobPayload, fallback: Date): Date {
  return payload.asOf ? new Date(payload.asOf) : fallback;
}

// Bills every subscription in the organization whose period has closed.
// Returns the run's totals rather than its per-subscription rows: the row
// detail is already durable (invoices, payments, campaigns), and a JobRun
// is meant to answer "did this run, and what did it do overall".
async function billingCycleHandler(payload: JobPayload, context: { now: Date }) {
  const summary = await billingService.runBillingCycle(payload.organizationId, {
    asOf: instantFor(payload, context.now),
    limit: payload.limit ?? DEFAULT_BILLING_LIMIT,
    subscriptionId: payload.subscriptionId,
    maxPeriodsPerSubscription: MAX_PERIODS_PER_SUBSCRIPTION,
  });

  return {
    subscriptionsConsidered: summary.subscriptionsConsidered,
    ...summary.totals,
  };
}

// Runs every dunning retry that has come due.
async function dunningSweepHandler(payload: JobPayload, context: { now: Date }) {
  const results = await dunningService.runDueDunning(payload.organizationId, {
    asOf: instantFor(payload, context.now),
    limit: payload.limit ?? DEFAULT_SWEEP_LIMIT,
  });

  return {
    campaignsRun: results.length,
    recovered: results.filter((result) => result.campaign.status === 'RECOVERED').length,
    exhausted: results.filter((result) => result.campaign.status === 'EXHAUSTED').length,
    stillScheduled: results.filter((result) => result.campaign.status === 'SCHEDULED').length,
  };
}

// Re-sends every webhook delivery whose retry has come due.
async function webhookRetryHandler(payload: JobPayload, context: { now: Date }) {
  const deliveries = await webhookService.retryDueWebhookDeliveries(payload.organizationId, {
    now: instantFor(payload, context.now),
    limit: payload.limit ?? DEFAULT_SWEEP_LIMIT,
  });

  return {
    attempted: deliveries.length,
    delivered: deliveries.filter((delivery) => delivery.status === 'SUCCEEDED').length,
    pending: deliveries.filter((delivery) => delivery.status === 'PENDING').length,
    failed: deliveries.filter((delivery) => delivery.status === 'FAILED').length,
  };
}

const HANDLERS: Record<JobName, (payload: JobPayload, context: { now: Date }) => Promise<unknown>> = {
  'billing.cycle': billingCycleHandler,
  'dunning.sweep': dunningSweepHandler,
  'webhook.retry': webhookRetryHandler,
};

let queue: InMemoryJobQueue | null = null;

export function getJobQueue(): InMemoryJobQueue {
  if (!queue) {
    queue = new InMemoryJobQueue({
      concurrency: env.WORKER_CONCURRENCY,
      onEvent: recordJobEvent,
      onError: (err, context) => logger.error({ err, ...context }, 'Background job error'),
    });

    for (const name of JOB_NAMES) {
      queue.register<JobPayload>(name, HANDLERS[name]);
    }
  }

  return queue;
}

// Drops the in-process queue, so a test (or a worker restarting its
// runtime) starts from an empty one. Persisted JobRun rows are untouched:
// they are history, not queue state.
export function resetJobQueue(): void {
  queue?.stop();
  queue = null;
}

function organizationIdOf(job: JobRecord): string | null {
  const payload = job.payload as Partial<JobPayload> | null;
  return payload?.organizationId ?? null;
}

function serializeResult(result: unknown): string | null {
  if (result === null || result === undefined) {
    return null;
  }

  const serialized = JSON.stringify(result);
  if (!serialized) {
    return null;
  }

  return serialized.length > MAX_SERIALIZED_RESULT_LENGTH
    ? JSON.stringify({ dropped: true, bytes: serialized.length })
    : serialized;
}

// Mirrors the queue's in-memory record into its JobRun row. Reached through
// the queue's onEvent hook, which already swallows and reports failures —
// bookkeeping must never be able to fail the work it is recording.
//
// The 'enqueued' event is deliberately not handled here: the queue fires it
// without awaiting (enqueue is synchronous), so a row created from it would
// race the worker picking the job up. queueJob below writes the row first
// and hands the queue its id, which also means a job can never be in flight
// with no row to record it against.
async function recordJobEvent(event: JobEvent): Promise<void> {
  const { job } = event;
  if (event.type === 'enqueued') {
    return;
  }

  const organizationId = organizationIdOf(job);
  if (!organizationId) {
    logger.warn({ jobId: job.id, name: job.name }, 'Job has no organization; not recording a run');
    return;
  }

  await prisma.jobRun.update({
    where: { id: job.id },
    data: {
      status: job.status,
      attemptsMade: job.attemptsMade,
      runAt: job.runAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      result: serializeResult(job.result),
      error: job.error,
    },
  });
}

// Writes the JobRun row, then hands the queue the same id. In that order:
// a worker polling in the background can pick the job up the instant it is
// queued, and an in-flight job whose row didn't exist yet would have
// nowhere to record that it started.
async function queueJob(
  organizationId: string,
  name: JobName,
  payload: JobPayload,
  options: { runAt?: Date; maxAttempts?: number } = {},
) {
  const run = await prisma.jobRun.create({
    data: {
      organizationId,
      name,
      status: 'PENDING',
      payload: JSON.stringify(payload),
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS,
      runAt: options.runAt ?? new Date(),
    },
  });

  try {
    getJobQueue().enqueue<JobPayload>(name, payload, {
      id: run.id,
      runAt: run.runAt,
      maxAttempts: run.maxAttempts,
    });
  } catch (err) {
    // Only reachable if the name has no handler, which would leave a row
    // that can never make progress.
    await prisma.jobRun.delete({ where: { id: run.id } });
    throw err;
  }

  return run;
}

// Queues one job for an organization and returns the row recording it. The
// caller's payload can't set `organizationId`: it comes from the
// authenticated token, so a tenant can never queue work against another.
export async function enqueueJob(organizationId: string, input: EnqueueJobInput) {
  return queueJob(
    organizationId,
    input.name,
    {
      organizationId,
      asOf: input.payload.asOf?.toISOString(),
      limit: input.payload.limit,
      subscriptionId: input.payload.subscriptionId,
    },
    { runAt: input.runAt, maxAttempts: input.maxAttempts },
  );
}

export interface RunDueJobsResult {
  ran: number;
  runs: Awaited<ReturnType<typeof listJobRuns>>;
}

// Runs this organization's due jobs now, rather than waiting for the
// worker's next tick. Filtered to the organization for the same reason
// every other read here is: the queue is shared by every tenant in the
// process.
export async function runDueJobs(
  organizationId: string,
  input: RunDueJobsInput,
): Promise<RunDueJobsResult> {
  const settled = await getJobQueue().runDue({
    now: input.asOf,
    limit: input.limit,
    filter: (job) => organizationIdOf(job) === organizationId,
  });

  const runs = await prisma.jobRun.findMany({
    where: { organizationId, id: { in: settled.map((job) => job.id) } },
    orderBy: { createdAt: 'desc' },
  });

  return { ran: settled.length, runs };
}

export async function listJobRuns(organizationId: string, query: ListJobRunsQuery) {
  return prisma.jobRun.findMany({
    where: { organizationId, status: query.status, name: query.name },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
  });
}

// Scoping the lookup to organizationId means a run belonging to another org
// 404s exactly like one that doesn't exist, rather than leaking a 403 that
// would confirm the id is real.
export async function getJobRun(organizationId: string, jobRunId: string) {
  const run = await prisma.jobRun.findFirst({ where: { id: jobRunId, organizationId } });

  if (!run) {
    throw ApiError.notFound('Job run not found');
  }

  return run;
}

// Whether this organization already has work of this name waiting or in
// flight. A sweep that is running behind must not have a second copy of
// itself queued on top of it every tick — two billing runs against the same
// subscriptions at the same time is exactly the race the single-invoice-
// per-period check in src/services/invoice.service.ts would then have to
// catch.
function hasQueuedJob(name: JobName, organizationId: string): boolean {
  return getJobQueue()
    .list({ name })
    .some(
      (job) =>
        (job.status === 'PENDING' || job.status === 'RUNNING') &&
        organizationIdOf(job) === organizationId,
    );
}

// Queues the recurring sweeps for every organization that doesn't already
// have one waiting. Called by the worker's scheduler (src/worker.ts) rather
// than by a request: it deliberately spans tenants, which is why it lives
// here and not behind an org-scoped endpoint.
export async function enqueueRecurringJobs(name: JobName, now: Date = new Date()) {
  const organizations = await prisma.organization.findMany({ select: { id: true } });

  const enqueued = [];
  for (const organization of organizations) {
    if (hasQueuedJob(name, organization.id)) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- each row is written before its job is queued
    enqueued.push(await queueJob(organization.id, name, { organizationId: organization.id }, { runAt: now }));
  }

  logger.debug(
    { name, enqueued: enqueued.length, skipped: organizations.length - enqueued.length },
    'Enqueued recurring jobs',
  );

  return enqueued;
}

export interface JobQueueSnapshot {
  registered: string[];
  counts: ReturnType<InMemoryJobQueue['counts']>;
  pending: number;
}

// What the queue is holding right now, for the operator endpoint. In-memory
// state, so it is a live view of this process only — the durable answer is
// listJobRuns.
export function describeQueue(): JobQueueSnapshot {
  const jobQueue = getJobQueue();
  const counts = jobQueue.counts();

  return {
    registered: jobQueue.registeredJobNames(),
    counts,
    pending: counts.PENDING,
  };
}
