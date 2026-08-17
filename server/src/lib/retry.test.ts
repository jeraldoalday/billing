import { describe, expect, it, vi } from 'vitest';
import { retryWithBackoff } from './retry';

// A no-op sleep so these tests run instantly instead of waiting out real
// backoff delays; the delay *durations* passed to it are asserted
// separately below.
const noSleep = async () => undefined;

describe('retryWithBackoff', () => {
  it('returns the first result when it is not retriable', async () => {
    const attempt = vi.fn().mockResolvedValue('ok');

    const result = await retryWithBackoff(attempt, {
      maxAttempts: 5,
      baseDelayMs: 10,
      isRetriable: () => false,
      sleep: noSleep,
    });

    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries until a non-retriable result is produced', async () => {
    const attempt = vi.fn().mockResolvedValueOnce('fail').mockResolvedValueOnce('fail').mockResolvedValueOnce('ok');

    const result = await retryWithBackoff(attempt, {
      maxAttempts: 5,
      baseDelayMs: 10,
      isRetriable: (r) => r === 'fail',
      sleep: noSleep,
    });

    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts and returns the last (still-retriable) result', async () => {
    const attempt = vi.fn().mockResolvedValue('fail');

    const result = await retryWithBackoff(attempt, {
      maxAttempts: 3,
      baseDelayMs: 10,
      isRetriable: (r) => r === 'fail',
      sleep: noSleep,
    });

    expect(result).toBe('fail');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('passes the 1-indexed attempt number to the attempt function, and to isRetriable for every non-final attempt', async () => {
    const attempt = vi.fn().mockResolvedValue('fail');
    const seenInIsRetriable: number[] = [];

    await retryWithBackoff(attempt, {
      maxAttempts: 3,
      baseDelayMs: 10,
      isRetriable: (_r, attemptNumber) => {
        seenInIsRetriable.push(attemptNumber);
        return true;
      },
      sleep: noSleep,
    });

    expect(attempt.mock.calls.map((call) => call[0])).toEqual([1, 2, 3]);
    // isRetriable is never consulted on the final attempt — there's no
    // decision left to make, since another retry isn't possible either way.
    expect(seenInIsRetriable).toEqual([1, 2]);
  });

  it('backs off exponentially between attempts by default (factor 2)', async () => {
    const attempt = vi.fn().mockResolvedValue('fail');
    const sleep = vi.fn().mockResolvedValue(undefined);

    await retryWithBackoff(attempt, {
      maxAttempts: 4,
      baseDelayMs: 100,
      isRetriable: () => true,
      sleep,
    });

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([100, 200, 400]);
  });

  it('honors a custom backoff factor', async () => {
    const attempt = vi.fn().mockResolvedValue('fail');
    const sleep = vi.fn().mockResolvedValue(undefined);

    await retryWithBackoff(attempt, {
      maxAttempts: 3,
      baseDelayMs: 50,
      factor: 3,
      isRetriable: () => true,
      sleep,
    });

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([50, 150]);
  });

  it('never sleeps when maxAttempts is 1', async () => {
    const attempt = vi.fn().mockResolvedValue('fail');
    const sleep = vi.fn().mockResolvedValue(undefined);

    await retryWithBackoff(attempt, {
      maxAttempts: 1,
      baseDelayMs: 50,
      isRetriable: () => true,
      sleep,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws for a maxAttempts less than 1', async () => {
    const attempt = vi.fn();

    await expect(
      retryWithBackoff(attempt, { maxAttempts: 0, baseDelayMs: 10, isRetriable: () => true }),
    ).rejects.toThrow('maxAttempts must be at least 1');
    expect(attempt).not.toHaveBeenCalled();
  });
});
