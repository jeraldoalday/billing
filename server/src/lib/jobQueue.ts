import { randomUUID } from 'node:crypto';
import {
  applyJobOutcome,
  DEFAULT_MAX_JOB_ATTEMPTS,
  describeJobError,
  isJobDue,
  isTerminalJobStatus,
  type JobBackoffOptions,
  type JobStatus,
} from '../domain/job';

// A small in-process job queue. Deliberately not Redis-backed: everything
// this platform runs in the background is a sweep over rows that are
// already durable in the database (invoices to generate, dunning retries
// due, webhook deliveries to re-send), so a job that is lost when the
// process dies is re-derived by the next tick rather than being work that
// vanished. What the queue adds over calling those sweeps directly is a
// concurrency limit, a retry budget with backoff, and a lifecycle other
// code can observe — src/services/job.service.ts subscribes to that
// lifecycle to persist a JobRun row per execution.
//
// Every decision about *when* a run happens comes from src/domain/job.ts;
// this class only holds the records and performs the calls.

export interface JobContext {
  /** Id of the run, matching the JobRun row src/services/job.service.ts writes. */
  id: string;
  name: string;
  /** 1-indexed attempt this invocation is. */
  attempt: number;
  /** The instant the queue is running as; a sweep should use this, not its own clock. */
  now: Date;
}

export type JobHandler<P = unknown> = (payload: P, context: JobContext) => Promise<unknown>;

export interface JobRecord<P = unknown> {
  id: string;
  name: string;
  payload: P;
  status: JobStatus;
  attemptsMade: number;
  maxAttempts: number;
  /** When this run becomes due. Never null: a settled run keeps the time of its last attempt. */
  runAt: Date;
  enqueuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  result: unknown;
  error: string | null;
}

export type JobEventType = 'enqueued' | 'started' | 'succeeded' | 'retry_scheduled' | 'failed';

export interface JobEvent {
  type: JobEventType;
  job: JobRecord;
}

export interface EnqueueOptions {
  /** Supply the id so a caller can pre-create the row this run is recorded on. */
  id?: string;
  /** When the run becomes due. Defaults to now (immediately). */
  runAt?: Date;
  maxAttempts?: number;
}

export interface JobQueueOptions {
  /** How many handlers may be in flight at once. */
  concurrency?: number;
  maxAttempts?: number;
  backoff?: JobBackoffOptions;
  /** Injectable so tests can drive the queue from a fixed instant. */
  clock?: () => Date;
  /**
   * Notified on every lifecycle transition, awaited so a subscriber that
   * persists the run can't fall behind the queue. A subscriber that throws
   * is reported through `onError` and otherwise ignored — bookkeeping must
   * never be able to fail the work itself.
   */
  onEvent?: (event: JobEvent) => void | Promise<void>;
  onError?: (err: unknown, context: { stage: string; job?: JobRecord }) => void;
  /** How many settled runs to keep for inspection before the oldest are pruned. */
  maxSettledRecords?: number;
}

export interface RunDueOptions {
  now?: Date;
  limit?: number;
  /**
   * Narrows a sweep to a subset of the due work — what an org-scoped
   * caller (POST /jobs/run) uses so triggering a sweep can never run
   * another tenant's job.
   */
  filter?: (job: JobRecord) => boolean;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_SETTLED_RECORDS = 200;
// Bounds drain()'s passes so a handler that keeps enqueueing more work
// can't turn one drain into an unbounded loop.
const MAX_DRAIN_PASSES = 20;

export class InMemoryJobQueue {
  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly backoff: JobBackoffOptions;
  private readonly clock: () => Date;
  private readonly onEvent?: (event: JobEvent) => void | Promise<void>;
  private readonly onError?: (err: unknown, context: { stage: string; job?: JobRecord }) => void;
  private readonly maxSettledRecords: number;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(options: JobQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS;
    this.backoff = options.backoff ?? {};
    this.clock = options.clock ?? (() => new Date());
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.maxSettledRecords = options.maxSettledRecords ?? DEFAULT_MAX_SETTLED_RECORDS;
  }

  register<P>(name: string, handler: JobHandler<P>): void {
    if (this.handlers.has(name)) {
      throw new Error(`A handler for job "${name}" is already registered`);
    }
    this.handlers.set(name, handler as JobHandler<never>);
  }

  hasHandler(name: string): boolean {
    return this.handlers.has(name);
  }

  registeredJobNames(): string[] {
    return [...this.handlers.keys()];
  }

  // Records a run and returns it. Enqueueing a name with no handler is a
  // programming error, not a runtime condition: the caller would otherwise
  // get a row that can never make progress and no signal that it won't.
  enqueue<P>(name: string, payload: P, options: EnqueueOptions = {}): JobRecord<P> {
    if (!this.handlers.has(name)) {
      throw new Error(`No handler registered for job "${name}"`);
    }

    const now = this.clock();
    const job: JobRecord<P> = {
      id: options.id ?? `job_${randomUUID().replace(/-/g, '')}`,
      name,
      payload,
      status: 'PENDING',
      attemptsMade: 0,
      maxAttempts: options.maxAttempts ?? this.maxAttempts,
      runAt: options.runAt ?? now,
      enqueuedAt: now,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    };

    this.jobs.set(job.id, job as JobRecord);
    void this.emit('enqueued', job as JobRecord);

    return job;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(filter: { status?: JobStatus; name?: string } = {}): JobRecord[] {
    return [...this.jobs.values()]
      .filter((job) => (filter.status ? job.status === filter.status : true))
      .filter((job) => (filter.name ? job.name === filter.name : true))
      .sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime());
  }

  size(): number {
    return this.jobs.size;
  }

  counts(): Record<JobStatus, number> {
    const counts: Record<JobStatus, number> = { PENDING: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0 };
    for (const job of this.jobs.values()) {
      counts[job.status] += 1;
    }
    return counts;
  }

  clear(): void {
    this.jobs.clear();
  }

  dueJobs(now: Date = this.clock()): JobRecord[] {
    return this.list({ status: 'PENDING' })
      .filter((job) => isJobDue(job, now))
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  }

  // Runs every job that is due, `concurrency` at a time, and returns the
  // records in the state they settled in. Never throws: a handler's failure
  // is the queue's ordinary business, recorded on the record and retried or
  // given up on according to the domain policy.
  async runDue(options: RunDueOptions = {}): Promise<JobRecord[]> {
    const now = options.now ?? this.clock();
    const due = this.dueJobs(now)
      .filter(options.filter ?? (() => true))
      .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER);
    if (due.length === 0) {
      return [];
    }

    const settled: JobRecord[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const job = due[cursor];
        cursor += 1;
        if (!job) {
          return;
        }
        // eslint-disable-next-line no-await-in-loop -- one worker runs its jobs in sequence; the pool is the parallelism
        settled.push(await this.runJob(job, now));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, due.length) }, () => worker()),
    );

    this.pruneSettled();

    return settled;
  }

  // Keeps running until nothing is due, so a caller that wants "everything
  // that can happen at this instant" doesn't have to loop itself. Retries
  // scheduled into the future are deliberately *not* waited for: they are
  // due later, and drain() answers a question about now.
  async drain(options: RunDueOptions = {}): Promise<JobRecord[]> {
    const now = options.now ?? this.clock();
    const settled: JobRecord[] = [];

    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
      // eslint-disable-next-line no-await-in-loop -- each pass may enqueue the work of the next
      const batch = await this.runDue({ ...options, now });
      if (batch.length === 0) {
        return settled;
      }
      settled.push(...batch);
    }

    return settled;
  }

  private async runJob(job: JobRecord, now: Date): Promise<JobRecord> {
    const handler = this.handlers.get(job.name);
    const attempt = job.attemptsMade + 1;

    job.status = 'RUNNING';
    job.startedAt = now;
    await this.emit('started', job);

    if (!handler) {
      // Only reachable if a handler is unregistered after work was queued;
      // treated as a failed attempt so it follows the ordinary retry budget
      // instead of sitting PENDING forever.
      return this.settle(job, 'FAILED', now, null, `No handler registered for job "${job.name}"`);
    }

    try {
      const result = await handler(job.payload as never, {
        id: job.id,
        name: job.name,
        attempt,
        now,
      });
      return await this.settle(job, 'SUCCEEDED', now, result ?? null, null);
    } catch (err) {
      this.onError?.(err, { stage: 'handler', job });
      return await this.settle(job, 'FAILED', now, null, describeJobError(err));
    }
  }

  private async settle(
    job: JobRecord,
    outcome: 'SUCCEEDED' | 'FAILED',
    now: Date,
    result: unknown,
    error: string | null,
  ): Promise<JobRecord> {
    const decision = applyJobOutcome(job, outcome, now, this.backoff);

    job.attemptsMade = decision.attemptsMade;
    job.status = decision.status;
    job.result = result;
    job.error = error;
    job.runAt = decision.runAt ?? now;
    job.finishedAt = isTerminalJobStatus(decision.status) ? now : null;

    if (decision.status === 'SUCCEEDED') {
      await this.emit('succeeded', job);
    } else if (decision.status === 'FAILED') {
      await this.emit('failed', job);
    } else {
      await this.emit('retry_scheduled', job);
    }

    return job;
  }

  private async emit(type: JobEventType, job: JobRecord): Promise<void> {
    if (!this.onEvent) {
      return;
    }
    try {
      await this.onEvent({ type, job: { ...job } });
    } catch (err) {
      this.onError?.(err, { stage: `event:${type}`, job });
    }
  }

  // A long-running worker would otherwise accumulate one record per sweep
  // forever. Settled runs are kept only as a recent-history window for
  // inspection; the durable record is the JobRun row.
  private pruneSettled(): void {
    const settled = this.list().filter((job) => isTerminalJobStatus(job.status));
    const excess = settled.length - this.maxSettledRecords;
    for (let i = 0; i < excess; i += 1) {
      const job = settled[i];
      if (job) {
        this.jobs.delete(job.id);
      }
    }
  }

  // Polls for due work on a timer. Overlapping ticks are skipped rather
  // than queued: a sweep that outruns its interval should fall behind, not
  // run twice against the same rows.
  start(intervalMs: number): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      if (this.sweeping) {
        return;
      }
      this.sweeping = true;
      void this.runDue()
        .catch((err) => this.onError?.(err, { stage: 'sweep' }))
        .finally(() => {
          this.sweeping = false;
        });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isPolling(): boolean {
    return this.timer !== null;
  }
}
