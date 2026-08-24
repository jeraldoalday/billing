// A recurring-task scheduler: the "every N milliseconds, do this" half of
// the background worker, kept separate from src/lib/jobQueue.ts (the "run
// this once, retrying if it fails" half). The worker in src/worker.ts wires
// the two together — a scheduled task typically only enqueues jobs, so the
// slow work happens under the queue's concurrency limit and retry budget
// rather than on the timer.
//
// There is no cron expression parsing here on purpose: every schedule this
// platform needs is a fixed interval, and a fixed interval is something a
// test can drive exactly by passing an instant to runDue().

export type ScheduledTaskRun = (now: Date) => Promise<unknown>;

export interface ScheduledTask {
  name: string;
  intervalMs: number;
  run: ScheduledTaskRun;
  /** When this task is next due. */
  nextRunAt: Date;
  lastRunAt: Date | null;
  runs: number;
  failures: number;
  lastError: string | null;
}

export interface ScheduleTaskOptions {
  /**
   * Whether the task is due as soon as it is registered. True by default: a
   * worker that has just started should sweep immediately rather than leave
   * work that is already due sitting for a full interval.
   */
  runImmediately?: boolean;
}

export interface SchedulerOptions {
  /** Injectable so tests can drive the scheduler from a fixed instant. */
  clock?: () => Date;
  onError?: (err: unknown, context: { task: string }) => void;
}

export interface SchedulerTickResult {
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class RecurringScheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly clock: () => Date;
  private readonly onError?: (err: unknown, context: { task: string }) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: SchedulerOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.onError = options.onError;
  }

  every(
    name: string,
    intervalMs: number,
    run: ScheduledTaskRun,
    options: ScheduleTaskOptions = {},
  ): ScheduledTask {
    if (this.tasks.has(name)) {
      throw new Error(`A task named "${name}" is already scheduled`);
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error('intervalMs must be a positive number');
    }

    const now = this.clock();
    const task: ScheduledTask = {
      name,
      intervalMs,
      run,
      nextRunAt: options.runImmediately === false ? new Date(now.getTime() + intervalMs) : now,
      lastRunAt: null,
      runs: 0,
      failures: 0,
      lastError: null,
    };

    this.tasks.set(name, task);
    return task;
  }

  remove(name: string): boolean {
    return this.tasks.delete(name);
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime());
  }

  get(name: string): ScheduledTask | undefined {
    return this.tasks.get(name);
  }

  dueTasks(now: Date = this.clock()): ScheduledTask[] {
    return this.list().filter((task) => task.nextRunAt.getTime() <= now.getTime());
  }

  // Runs every task that is due, in the order they came due. Sequential
  // rather than parallel: the tasks share a database connection pool, and
  // the point of a task here is to enqueue work, not to be the work.
  //
  // A task that throws is recorded on the task (and reported through
  // onError) and still rescheduled — a scheduler that stopped running a
  // task because one tick failed would turn a transient outage into a
  // permanent one.
  async runDue(now: Date = this.clock()): Promise<SchedulerTickResult[]> {
    const results: SchedulerTickResult[] = [];

    for (const task of this.dueTasks(now)) {
      try {
        // eslint-disable-next-line no-await-in-loop -- tasks share a connection pool; deliberately sequential
        const result = await task.run(now);
        task.failures = 0;
        task.lastError = null;
        results.push({ name: task.name, ok: true, result });
      } catch (err) {
        task.failures += 1;
        task.lastError = err instanceof Error ? err.message : String(err);
        this.onError?.(err, { task: task.name });
        results.push({ name: task.name, ok: false, error: task.lastError });
      } finally {
        task.runs += 1;
        task.lastRunAt = now;
        task.nextRunAt = this.scheduleAfter(task, now);
      }
    }

    return results;
  }

  // The next run is measured from `now` rather than from the previous
  // nextRunAt, so a task that took longer than its interval (or a worker
  // that was asleep) doesn't come back to a backlog of missed ticks it
  // would then run back to back.
  private scheduleAfter(task: ScheduledTask, now: Date): Date {
    return new Date(now.getTime() + task.intervalMs);
  }

  // Polls on a timer, at a resolution finer than any task's interval.
  // Overlapping ticks are skipped, for the same reason the queue skips
  // them: falling behind is correct, running twice is not.
  start(tickMs: number): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      if (this.ticking) {
        return;
      }
      this.ticking = true;
      void this.runDue()
        .catch((err) => this.onError?.(err, { task: 'scheduler' }))
        .finally(() => {
          this.ticking = false;
        });
    }, tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
