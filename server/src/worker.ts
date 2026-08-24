import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { RecurringScheduler } from './lib/scheduler';
import type { InMemoryJobQueue } from './lib/jobQueue';
import { JOB_NAMES, type JobName } from './domain/job';
import * as jobService from './services/job.service';

// The background worker: a second entry point beside src/index.ts (the HTTP
// server), running the recurring sweeps that make billing happen without
// anyone calling an endpoint.
//
// Two moving parts, deliberately separate: the scheduler decides *when* a
// sweep is due and does nothing but enqueue it, and the queue runs the work
// under a concurrency limit with a retry budget. That split is what keeps a
// slow billing run from delaying the dunning schedule, and what makes a
// failed sweep retry on its own backoff rather than waiting a full interval.
//
// Running more than one worker process against the same database is not
// supported today: the queue is in-process, so two workers would each
// enqueue their own copy of every sweep. They would not double-bill
// (invoice generation refuses a second invoice for the same period, and
// dunning campaigns are unique per invoice), but they would do the work
// twice. One worker is the intended deployment.

export interface WorkerOptions {
  tickMs?: number;
  billingIntervalMs?: number;
  dunningIntervalMs?: number;
  webhookRetryIntervalMs?: number;
  /** Injectable so tests can drive the worker from a fixed instant. */
  clock?: () => Date;
}

export interface Worker {
  scheduler: RecurringScheduler;
  queue: InMemoryJobQueue;
  /** Enqueues every sweep that is due and runs it to completion. */
  runOnce(now?: Date): Promise<void>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

const INTERVAL_OPTION: Record<JobName, keyof WorkerOptions> = {
  'billing.cycle': 'billingIntervalMs',
  'dunning.sweep': 'dunningIntervalMs',
  'webhook.retry': 'webhookRetryIntervalMs',
};

const DEFAULT_INTERVALS: Record<JobName, number> = {
  'billing.cycle': env.WORKER_BILLING_INTERVAL_MS,
  'dunning.sweep': env.WORKER_DUNNING_INTERVAL_MS,
  'webhook.retry': env.WORKER_WEBHOOK_RETRY_INTERVAL_MS,
};

export function createWorker(options: WorkerOptions = {}): Worker {
  const tickMs = options.tickMs ?? env.WORKER_TICK_MS;
  const queue = jobService.getJobQueue();
  const scheduler = new RecurringScheduler({
    clock: options.clock,
    onError: (err, context) => logger.error({ err, ...context }, 'Scheduled task failed'),
  });

  // Every task does the same small thing: queue this sweep for every
  // organization that doesn't already have one waiting. The work itself
  // happens on the queue, so a task can never hold the scheduler.
  for (const name of JOB_NAMES) {
    const intervalMs = (options[INTERVAL_OPTION[name]] as number | undefined) ?? DEFAULT_INTERVALS[name];
    scheduler.every(name, intervalMs, (now) => jobService.enqueueRecurringJobs(name, now));
  }

  return {
    scheduler,
    queue,

    async runOnce(now = new Date()) {
      await scheduler.runDue(now);
      await queue.drain({ now });
    },

    start() {
      scheduler.start(tickMs);
      queue.start(tickMs);
      logger.info(
        {
          tickMs,
          concurrency: env.WORKER_CONCURRENCY,
          intervals: DEFAULT_INTERVALS,
        },
        'Billing worker started',
      );
    },

    stop() {
      scheduler.stop();
      queue.stop();
    },

    isRunning() {
      return scheduler.isRunning();
    },
  };
}

// `--once` runs a single pass and exits, for a deployment that would rather
// drive the sweeps from cron than keep a process alive.
async function main(): Promise<void> {
  const worker = createWorker();
  const runOnce = process.argv.includes('--once');

  if (runOnce) {
    await worker.runOnce();
    logger.info('Billing worker completed a single pass');
    await prisma.$disconnect();
    return;
  }

  worker.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    // A second Ctrl-C shouldn't start a second shutdown while the first is
    // still closing the database connection.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, 'Billing worker shutting down');
    worker.stop();
    void prisma.$disconnect().finally(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'Billing worker failed to start');
    process.exit(1);
  });
}
