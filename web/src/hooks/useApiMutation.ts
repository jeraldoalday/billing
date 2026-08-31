import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

/**
 * Runs one write against the API and tracks what came back.
 *
 * The counterpart to `useApiQuery`, and deliberately shaped so a form never
 * has to write its own try/catch: `mutate` resolves with the created or
 * updated record on success and with `null` on failure, having already put
 * the error — and the server's per-field messages — into state for the form
 * to render.
 *
 * Two things it handles that are easy to get wrong in a form:
 *
 * - A second submit while the first is still in flight is dropped. Double
 *   clicking "Create customer" must not create two customers, and a
 *   disabled button alone does not prevent the second click that lands
 *   before React re-renders.
 * - A response that arrives after the component has gone (the dialog was
 *   closed, the user navigated away) does not set state on a dead tree.
 */

export interface UseApiMutationResult<TInput, TData> {
  mutate: (input: TInput) => Promise<TData | null>;
  isPending: boolean;
  error: ApiError | null;
  /** Per-field messages from a 400, keyed the way the form's inputs are. */
  fieldErrors: Record<string, string[] | undefined>;
  /** Clears the last failure, e.g. when the dialog is reopened. */
  reset: () => void;
}

export function useApiMutation<TInput, TData>(
  perform: (input: TInput) => Promise<TData>,
): UseApiMutationResult<TInput, TData> {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const performRef = useRef(perform);
  performRef.current = perform;

  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutate = useCallback(async (input: TInput): Promise<TData | null> => {
    if (pendingRef.current) {
      return null;
    }

    pendingRef.current = true;
    setPending(true);
    setError(null);

    try {
      const data = await performRef.current(input);
      return data;
    } catch (cause) {
      const failure =
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'UNKNOWN_ERROR', 'Something went wrong', cause);
      if (mountedRef.current) {
        setError(failure);
      }
      return null;
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) {
        setPending(false);
      }
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
  }, []);

  return {
    mutate,
    isPending,
    error,
    fieldErrors: error?.fieldErrors ?? {},
    reset,
  };
}

/**
 * The message to show above a form for a failed write.
 *
 * A validation failure is already reported field by field, so repeating its
 * generic "Invalid request" at the top would say nothing; anything else —
 * a conflict, a 500, a dead server — needs a line of its own or the form
 * looks like it silently did nothing.
 */
export function formErrorMessage(error: ApiError | null): string | null {
  if (!error) {
    return null;
  }
  if (error.code === 'NETWORK_ERROR') {
    return 'Could not reach the billing API. Is the server running?';
  }
  if (error.code === 'VALIDATION_ERROR' && Object.keys(error.fieldErrors).length > 0) {
    return null;
  }
  return error.message;
}
