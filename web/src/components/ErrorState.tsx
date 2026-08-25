import type { ApiError } from '../api/client';

export interface ErrorStateProps {
  error: ApiError;
  onRetry?: () => void;
}

/** What a page shows when its load failed, with a way to try again. */
export function ErrorState({ error, onRetry }: ErrorStateProps) {
  const message =
    error.code === 'NETWORK_ERROR'
      ? 'Could not reach the billing API. Is the server running?'
      : error.message;

  return (
    <div
      role="alert"
      className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-800"
    >
      <p className="font-semibold">Could not load this page</p>
      <p className="mt-1">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 transition hover:bg-red-100"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
