import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  /** What the screen would show once there is something to show. */
  description?: string;
  action?: ReactNode;
}

/**
 * What a list renders when it loaded successfully and found nothing.
 *
 * Deliberately distinct from `ErrorState`: "you have no customers yet" and
 * "we could not load your customers" look identical if both are a grey line
 * of text, and only one of them means something is broken.
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {description ? <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
