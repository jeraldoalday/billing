// Generic retry-with-exponential-backoff wrapper. Not payment-specific —
// anything that produces a result which may or may not warrant another
// attempt (a flaky external call, a transient gateway error) can use this
// instead of hand-rolling its own attempt loop.

export interface RetryOptions<T> {
  /** Total number of attempts, including the first. Must be >= 1. */
  maxAttempts: number;
  /** Delay before the second attempt; each subsequent delay multiplies by `factor`. */
  baseDelayMs: number;
  /** Growth rate of the delay between attempts. Defaults to 2 (doubling). */
  factor?: number;
  /** Given the latest result and the attempt number that produced it, should we try again? */
  isRetriable: (result: T, attempt: number) => boolean;
  /** Injectable for tests so retries don't actually wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls `attempt(n)` (1-indexed) until it returns a non-retriable result or
// `maxAttempts` is reached, whichever comes first, backing off
// exponentially between tries. Always returns the *last* result rather than
// throwing — callers that want failed-vs-succeeded semantics decide that
// from the returned value, since "retriable" and "failed" aren't the same
// thing (a call can fail permanently on attempt 1 with nothing to retry).
export async function retryWithBackoff<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: RetryOptions<T>,
): Promise<T> {
  const { maxAttempts, baseDelayMs, factor = 2, isRetriable, sleep = defaultSleep } = options;
  if (maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1');
  }

  let result: T;
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    // eslint-disable-next-line no-await-in-loop -- attempts are inherently sequential
    result = await attempt(attemptNumber);

    const isLastAttempt = attemptNumber === maxAttempts;
    if (isLastAttempt || !isRetriable(result, attemptNumber)) {
      return result;
    }

    const delayMs = baseDelayMs * factor ** (attemptNumber - 1);
    // eslint-disable-next-line no-await-in-loop -- backoff must happen between attempts, not concurrently
    await sleep(delayMs);
  }

  // Unreachable: the loop always returns once attemptNumber reaches
  // maxAttempts, and maxAttempts >= 1 is checked above.
  throw new Error('retryWithBackoff: no attempt was made');
}
