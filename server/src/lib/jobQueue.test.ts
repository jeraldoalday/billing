import { describe, expect, it, vi } from 'vitest';
import { InMemoryJobQueue, type JobEvent, type JobRecord } from './jobQueue';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

describe('registering handlers', () => {
  it('lists what it knows how to run', () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    queue.register('billing.cycle', async () => 'ok');

    expect(queue.registeredJobNames()).toEqual(['billing.cycle']);
    expect(queue.hasHandler('billing.cycle')).toBe(true);
    expect(queue.hasHandler('dunning.sweep')).toBe(false);
  });

  it('refuses to register the same name twice', () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    queue.register('billing.cycle', async () => 'ok');

    expect(() => queue.register('billing.cycle', async () => 'ok')).toThrow(/already registered/);
  });

  it('refuses to enqueue work nothing can run', () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });

    expect(() => queue.enqueue('nope', {})).toThrow(/No handler registered/);
  });
});

describe('enqueueing', () => {
  it('records a pending run due immediately', () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    queue.register('billing.cycle', async () => 'ok');

    const job = queue.enqueue('billing.cycle', { organizationId: 'org_1' });

    expect(job.status).toBe('PENDING');
    expect(job.attemptsMade).toBe(0);
    expect(job.runAt).toEqual(NOW);
    expect(job.payload).toEqual({ organizationId: 'org_1' });
    expect(queue.get(job.id)?.id).toBe(job.id);
  });

  it('accepts a caller-supplied id so a persisted row can share it', () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    queue.register('billing.cycle', async () => 'ok');

    const job = queue.enqueue('billing.cycle', {}, { id: 'run_abc' });

    expect(job.id).toBe('run_abc');
  });

  it('holds back a run scheduled for later', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    const handler = vi.fn(async () => 'ok');
    queue.register('billing.cycle', handler);
    queue.enqueue('billing.cycle', {}, { runAt: at(60_000) });

    expect(queue.dueJobs(NOW)).toHaveLength(0);
    await queue.runDue({ now: NOW });
    expect(handler).not.toHaveBeenCalled();

    await queue.runDue({ now: at(60_000) });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('running due work', () => {
  it('runs a handler with its payload and context, and keeps the result', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    const handler = vi.fn(async () => ({ processed: 3 }));
    queue.register('billing.cycle', handler);
    const job = queue.enqueue('billing.cycle', { organizationId: 'org_1' });

    const [settled] = await queue.runDue({ now: NOW });

    expect(handler).toHaveBeenCalledWith(
      { organizationId: 'org_1' },
      { id: job.id, name: 'billing.cycle', attempt: 1, now: NOW },
    );
    expect(settled?.status).toBe('SUCCEEDED');
    expect(settled?.result).toEqual({ processed: 3 });
    expect(settled?.attemptsMade).toBe(1);
    expect(settled?.finishedAt).toEqual(NOW);
  });

  it('does not run a settled job again', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    const handler = vi.fn(async () => 'ok');
    queue.register('billing.cycle', handler);
    queue.enqueue('billing.cycle', {});

    await queue.runDue({ now: NOW });
    await queue.runDue({ now: at(600_000) });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs due jobs oldest-due first', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW, concurrency: 1 });
    const order: string[] = [];
    queue.register('billing.cycle', async (payload: { tag: string }) => {
      order.push(payload.tag);
      return null;
    });

    queue.enqueue('billing.cycle', { tag: 'late' }, { runAt: at(5_000) });
    queue.enqueue('billing.cycle', { tag: 'early' }, { runAt: at(-5_000) });

    await queue.runDue({ now: at(10_000) });

    expect(order).toEqual(['early', 'late']);
  });

  it('honours a limit on how much it picks up in one pass', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    queue.register('billing.cycle', async () => 'ok');
    queue.enqueue('billing.cycle', {});
    queue.enqueue('billing.cycle', {});
    queue.enqueue('billing.cycle', {});

    const settled = await queue.runDue({ now: NOW, limit: 2 });

    expect(settled).toHaveLength(2);
    expect(queue.counts()).toMatchObject({ PENDING: 1, SUCCEEDED: 2 });
  });

  it('never runs more handlers at once than its concurrency allows', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW, concurrency: 2 });
    let inFlight = 0;
    let peak = 0;
    queue.register('billing.cycle', async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return null;
    });
    for (let i = 0; i < 6; i += 1) {
      queue.enqueue('billing.cycle', {});
    }

    await queue.runDue({ now: NOW });

    expect(peak).toBe(2);
    expect(queue.counts().SUCCEEDED).toBe(6);
  });

  it('returns nothing when there is no due work', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    queue.register('billing.cycle', async () => 'ok');

    expect(await queue.runDue({ now: NOW })).toEqual([]);
  });
});

describe('failure handling', () => {
  it('reschedules a failed run with backoff instead of failing it outright', async () => {
    const queue = new InMemoryJobQueue({
      clock: () => NOW,
      backoff: { baseDelayMs: 1_000, factor: 2 },
    });
    queue.register('billing.cycle', async () => {
      throw new Error('database is down');
    });
    queue.enqueue('billing.cycle', {});

    const [settled] = await queue.runDue({ now: NOW });

    expect(settled?.status).toBe('PENDING');
    expect(settled?.attemptsMade).toBe(1);
    expect(settled?.error).toBe('database is down');
    expect(settled?.runAt).toEqual(at(1_000));
    expect(settled?.finishedAt).toBeNull();
  });

  it('retries on the next sweep and can still succeed', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW, backoff: { baseDelayMs: 1_000 } });
    let calls = 0;
    queue.register('billing.cycle', async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('transient');
      }
      return 'recovered';
    });
    queue.enqueue('billing.cycle', {});

    await queue.runDue({ now: NOW });
    const [settled] = await queue.runDue({ now: at(1_000) });

    expect(calls).toBe(2);
    expect(settled?.status).toBe('SUCCEEDED');
    expect(settled?.result).toBe('recovered');
    expect(settled?.attemptsMade).toBe(2);
    expect(settled?.error).toBeNull();
  });

  it('gives up once the attempt budget is spent', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW, backoff: { baseDelayMs: 1_000 } });
    queue.register('billing.cycle', async () => {
      throw new Error('still broken');
    });
    queue.enqueue('billing.cycle', {}, { maxAttempts: 2 });

    await queue.runDue({ now: NOW });
    const [settled] = await queue.runDue({ now: at(60_000) });

    expect(settled?.status).toBe('FAILED');
    expect(settled?.attemptsMade).toBe(2);
    expect(settled?.finishedAt).toEqual(at(60_000));
  });

  it('reports handler errors to onError without throwing out of runDue', async () => {
    const onError = vi.fn();
    const queue = new InMemoryJobQueue({ clock: () => NOW, onError });
    queue.register('billing.cycle', async () => {
      throw new Error('boom');
    });
    queue.enqueue('billing.cycle', {});

    await expect(queue.runDue({ now: NOW })).resolves.toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ stage: 'handler' }));
  });

  it('lets one failing job settle without stopping the others in the pass', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW, concurrency: 3 });
    queue.register('billing.cycle', async (payload: { fail: boolean }) => {
      if (payload.fail) {
        throw new Error('one bad org');
      }
      return 'ok';
    });
    queue.enqueue('billing.cycle', { fail: true });
    queue.enqueue('billing.cycle', { fail: false });
    queue.enqueue('billing.cycle', { fail: false });

    const settled = await queue.runDue({ now: NOW });

    expect(settled.filter((job) => job.status === 'SUCCEEDED')).toHaveLength(2);
    expect(settled.filter((job) => job.status === 'PENDING')).toHaveLength(1);
  });
});

describe('lifecycle events', () => {
  it('reports enqueue, start and success in order', async () => {
    const events: JobEvent[] = [];
    const queue = new InMemoryJobQueue({ clock: () => NOW, onEvent: (event) => void events.push(event) });
    queue.register('billing.cycle', async () => 'ok');
    queue.enqueue('billing.cycle', {});

    await queue.runDue({ now: NOW });

    expect(events.map((event) => event.type)).toEqual(['enqueued', 'started', 'succeeded']);
  });

  it('reports a retry and then the eventual give-up', async () => {
    const events: JobEvent[] = [];
    const queue = new InMemoryJobQueue({
      clock: () => NOW,
      backoff: { baseDelayMs: 1_000 },
      onEvent: (event) => void events.push(event),
    });
    queue.register('billing.cycle', async () => {
      throw new Error('nope');
    });
    queue.enqueue('billing.cycle', {}, { maxAttempts: 2 });

    await queue.runDue({ now: NOW });
    await queue.runDue({ now: at(60_000) });

    expect(events.map((event) => event.type)).toEqual([
      'enqueued',
      'started',
      'retry_scheduled',
      'started',
      'failed',
    ]);
  });

  it('hands subscribers a snapshot, not the live record', async () => {
    const seen: JobRecord[] = [];
    const queue = new InMemoryJobQueue({
      clock: () => NOW,
      onEvent: (event) => void seen.push(event.job),
    });
    queue.register('billing.cycle', async () => 'ok');
    queue.enqueue('billing.cycle', {});

    await queue.runDue({ now: NOW });

    expect(seen[0]?.status).toBe('PENDING');
    expect(seen[1]?.status).toBe('RUNNING');
    expect(seen[2]?.status).toBe('SUCCEEDED');
  });

  it('keeps running when a subscriber throws', async () => {
    const onError = vi.fn();
    const queue = new InMemoryJobQueue({
      clock: () => NOW,
      onError,
      onEvent: () => {
        throw new Error('recorder is down');
      },
    });
    queue.register('billing.cycle', async () => 'ok');
    queue.enqueue('billing.cycle', {});

    const [settled] = await queue.runDue({ now: NOW });

    expect(settled?.status).toBe('SUCCEEDED');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ stage: 'event:succeeded' }));
  });
});

describe('draining', () => {
  it('keeps going while handlers enqueue more due work', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    let spawned = 0;
    queue.register('billing.cycle', async () => {
      if (spawned < 2) {
        spawned += 1;
        queue.enqueue('billing.cycle', {});
      }
      return null;
    });
    queue.enqueue('billing.cycle', {});

    const settled = await queue.drain({ now: NOW });

    expect(settled).toHaveLength(3);
    expect(queue.counts().PENDING).toBe(0);
  });

  it('leaves work scheduled for the future alone', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    queue.register('billing.cycle', async () => 'ok');
    queue.enqueue('billing.cycle', {}, { runAt: at(30_000) });

    expect(await queue.drain({ now: NOW })).toEqual([]);
    expect(queue.counts().PENDING).toBe(1);
  });
});

describe('inspection and retention', () => {
  it('filters records by status and name', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    queue.register('billing.cycle', async () => 'ok');
    queue.register('dunning.sweep', async () => 'ok');
    queue.enqueue('billing.cycle', {});
    queue.enqueue('dunning.sweep', {}, { runAt: at(60_000) });

    await queue.runDue({ now: NOW });

    expect(queue.list({ name: 'billing.cycle' })).toHaveLength(1);
    expect(queue.list({ status: 'PENDING' })).toHaveLength(1);
    expect(queue.counts()).toEqual({ PENDING: 1, RUNNING: 0, SUCCEEDED: 1, FAILED: 0 });
  });

  it('prunes the oldest settled runs so a long-lived worker stays bounded', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW, maxSettledRecords: 2 });
    queue.register('billing.cycle', async () => 'ok');
    for (let i = 0; i < 5; i += 1) {
      queue.enqueue('billing.cycle', { index: i });
    }

    await queue.runDue({ now: NOW });

    expect(queue.size()).toBe(2);
    expect(queue.list().map((job) => (job.payload as { index: number }).index)).toEqual([3, 4]);
  });

  it('clears everything on request', async () => {
    const queue = new InMemoryJobQueue({ clock: () => NOW });
    queue.register('billing.cycle', async () => 'ok');
    queue.enqueue('billing.cycle', {});

    queue.clear();

    expect(queue.size()).toBe(0);
  });
});

describe('polling', () => {
  it('sweeps due work on a timer until it is stopped', async () => {
    vi.useFakeTimers();
    try {
      const queue = new InMemoryJobQueue({ concurrency: 1 });
      const handler = vi.fn(async () => 'ok');
      queue.register('billing.cycle', handler);
      queue.enqueue('billing.cycle', {});

      queue.start(1_000);
      expect(queue.isPolling()).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(handler).toHaveBeenCalledTimes(1);

      queue.stop();
      queue.enqueue('billing.cycle', {});
      await vi.advanceTimersByTimeAsync(5_000);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(queue.isPolling()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starting twice does not double up the timer', async () => {
    vi.useFakeTimers();
    try {
      const queue = new InMemoryJobQueue();
      const handler = vi.fn(async () => 'ok');
      queue.register('billing.cycle', handler);
      queue.start(1_000);
      queue.start(1_000);
      queue.enqueue('billing.cycle', {});

      await vi.advanceTimersByTimeAsync(1_000);

      expect(handler).toHaveBeenCalledTimes(1);
      queue.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a tick while the previous sweep is still running', async () => {
    vi.useFakeTimers();
    try {
      const queue = new InMemoryJobQueue({ concurrency: 1 });
      let started = 0;
      queue.register('billing.cycle', async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return null;
      });
      queue.enqueue('billing.cycle', {});
      queue.enqueue('billing.cycle', {});

      queue.start(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      // The second tick found the first sweep still in flight and did
      // nothing, so only the first sweep's jobs are running.
      expect(started).toBe(1);

      await vi.advanceTimersByTimeAsync(20_000);
      queue.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
