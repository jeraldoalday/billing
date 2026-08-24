import { describe, expect, it, vi } from 'vitest';
import { RecurringScheduler } from './scheduler';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

describe('registering tasks', () => {
  it('schedules a task as due immediately by default', () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });

    const task = scheduler.every('billing', 60_000, async () => null);

    expect(task.nextRunAt).toEqual(NOW);
    expect(scheduler.dueTasks(NOW)).toHaveLength(1);
  });

  it('can wait a full interval before the first run', () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });

    const task = scheduler.every('billing', 60_000, async () => null, { runImmediately: false });

    expect(task.nextRunAt).toEqual(at(60_000));
    expect(scheduler.dueTasks(NOW)).toHaveLength(0);
  });

  it('refuses a duplicate task name', () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });
    scheduler.every('billing', 60_000, async () => null);

    expect(() => scheduler.every('billing', 60_000, async () => null)).toThrow(/already scheduled/);
  });

  it('rejects a nonsensical interval', () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });

    expect(() => scheduler.every('billing', 0, async () => null)).toThrow(/positive number/);
    expect(() => scheduler.every('billing', -5, async () => null)).toThrow(/positive number/);
  });

  it('lists tasks in the order they come due, and can drop one', () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });
    scheduler.every('late', 60_000, async () => null, { runImmediately: false });
    scheduler.every('now', 60_000, async () => null);

    expect(scheduler.list().map((task) => task.name)).toEqual(['now', 'late']);
    expect(scheduler.remove('late')).toBe(true);
    expect(scheduler.remove('late')).toBe(false);
    expect(scheduler.list()).toHaveLength(1);
  });
});

describe('runDue', () => {
  it('runs a due task with the instant the sweep is for', async () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });
    const run = vi.fn(async () => 'swept');
    scheduler.every('billing', 60_000, run);

    const results = await scheduler.runDue(NOW);

    expect(run).toHaveBeenCalledWith(NOW);
    expect(results).toEqual([{ name: 'billing', ok: true, result: 'swept' }]);
  });

  it('leaves a task alone until its interval has passed', async () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });
    const run = vi.fn(async () => null);
    scheduler.every('billing', 60_000, run);

    await scheduler.runDue(NOW);
    await scheduler.runDue(at(30_000));
    expect(run).toHaveBeenCalledTimes(1);

    await scheduler.runDue(at(60_000));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs due tasks in order, one at a time', async () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });
    const order: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const task = (name: string) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      order.push(name);
      return null;
    };
    scheduler.every('first', 60_000, task('first'));
    scheduler.every('second', 90_000, task('second'));

    await scheduler.runDue(NOW);

    expect(order).toEqual(['first', 'second']);
    expect(peak).toBe(1);
  });

  it('measures the next run from the sweep, so a slow worker does not build a backlog', async () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });
    const run = vi.fn(async () => null);
    scheduler.every('billing', 60_000, run);

    // The worker was asleep for an hour; the task runs once, not sixty times.
    await scheduler.runDue(at(3_600_000));

    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.get('billing')?.nextRunAt).toEqual(at(3_660_000));
  });

  it('tracks run counts and the last run time', async () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });
    scheduler.every('billing', 60_000, async () => null);

    await scheduler.runDue(NOW);
    await scheduler.runDue(at(60_000));

    expect(scheduler.get('billing')).toMatchObject({ runs: 2, failures: 0, lastError: null });
    expect(scheduler.get('billing')?.lastRunAt).toEqual(at(60_000));
  });
});

describe('failing tasks', () => {
  it('records the failure and keeps the task scheduled', async () => {
    const onError = vi.fn();
    const scheduler = new RecurringScheduler({ clock: () => NOW, onError });
    scheduler.every('billing', 60_000, async () => {
      throw new Error('database is down');
    });

    const results = await scheduler.runDue(NOW);

    expect(results).toEqual([{ name: 'billing', ok: false, error: 'database is down' }]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { task: 'billing' });
    expect(scheduler.get('billing')).toMatchObject({ runs: 1, failures: 1 });
    expect(scheduler.get('billing')?.nextRunAt).toEqual(at(60_000));
  });

  it('counts consecutive failures and clears the count on recovery', async () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });
    let healthy = false;
    scheduler.every('billing', 60_000, async () => {
      if (!healthy) {
        throw new Error('still down');
      }
      return 'ok';
    });

    await scheduler.runDue(NOW);
    await scheduler.runDue(at(60_000));
    expect(scheduler.get('billing')?.failures).toBe(2);

    healthy = true;
    await scheduler.runDue(at(120_000));

    expect(scheduler.get('billing')).toMatchObject({ failures: 0, lastError: null });
  });

  it('does not let one failing task stop the others in the sweep', async () => {
    const scheduler = new RecurringScheduler({ clock: () => NOW });
    const healthy = vi.fn(async () => null);
    scheduler.every('broken', 60_000, async () => {
      throw new Error('nope');
    });
    scheduler.every('healthy', 60_000, healthy);

    const results = await scheduler.runDue(NOW);

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.ok)).toEqual([false, true]);
  });
});

describe('polling', () => {
  it('ticks tasks on a timer until it is stopped', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new RecurringScheduler();
      const run = vi.fn(async () => null);
      scheduler.every('billing', 1_000, run, { runImmediately: false });

      scheduler.start(100);
      expect(scheduler.isRunning()).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(run).toHaveBeenCalledTimes(1);
      expect(scheduler.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starting twice does not double up the timer', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new RecurringScheduler();
      const run = vi.fn(async () => null);
      scheduler.every('billing', 1_000, run, { runImmediately: false });

      scheduler.start(100);
      scheduler.start(100);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(run).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a tick while the previous one is still running', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new RecurringScheduler();
      let started = 0;
      scheduler.every('billing', 100, async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return null;
      });

      scheduler.start(100);
      await vi.advanceTimersByTimeAsync(400);

      expect(started).toBe(1);

      await vi.advanceTimersByTimeAsync(10_000);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
