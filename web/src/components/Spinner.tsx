export interface SpinnerProps {
  label?: string;
}

/**
 * A busy indicator. The label is visually hidden but announced, so a
 * loading screen is not silent to a screen reader.
 */
export function Spinner({ label = 'Loading' }: SpinnerProps) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-slate-500">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The full-page version, used while the session is being revalidated. */
export function FullPageSpinner({ label = 'Loading' }: SpinnerProps) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center">
      <Spinner label={label} />
    </div>
  );
}
