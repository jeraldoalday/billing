import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

/**
 * Runs one read against the API and tracks its three outcomes.
 *
 * Deliberately small — this is not a cache. What it does buy every page is
 * the handling that is easy to get subtly wrong: the request is aborted
 * when the component unmounts, a response that arrives after a newer one
 * was started is discarded rather than overwriting it, and `refetch` is
 * stable so it can sit in a dependency array without looping.
 */

export type QueryState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: null; error: ApiError };

export interface UseApiQueryResult<T> {
  status: QueryState<T>['status'];
  data: T | null;
  error: ApiError | null;
  isLoading: boolean;
  refetch: () => void;
}

export interface UseApiQueryOptions {
  /** Skip the request entirely, e.g. while an id is still unknown. */
  enabled?: boolean;
}

export function useApiQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: UseApiQueryOptions = {},
): UseApiQueryResult<T> {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<QueryState<T>>({
    status: 'loading',
    data: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  // Identifies the newest run, so a slow earlier response can be ignored
  // when it finally lands.
  const runIdRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const controller = new AbortController();
    const runId = ++runIdRef.current;
    setState({ status: 'loading', data: null, error: null });

    fetcherRef
      .current(controller.signal)
      .then((data) => {
        if (runId !== runIdRef.current) return;
        setState({ status: 'success', data, error: null });
      })
      .catch((cause: unknown) => {
        if (runId !== runIdRef.current) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          return;
        }
        const error =
          cause instanceof ApiError
            ? cause
            : new ApiError(0, 'UNKNOWN_ERROR', 'Something went wrong', cause);
        setState({ status: 'error', data: null, error });
      });

    return () => {
      controller.abort();
    };
    // The fetcher is held in a ref so an inline arrow function does not
    // re-run this on every render; the caller declares what it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, attempt, ...deps]);

  const refetch = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return {
    status: state.status,
    data: state.data,
    error: state.error,
    isLoading: state.status === 'loading',
    refetch,
  };
}
