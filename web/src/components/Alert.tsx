import type { ReactNode } from 'react';

export type AlertTone = 'error' | 'info' | 'success';

const TONE_CLASSES: Record<AlertTone, string> = {
  error: 'border-red-200 bg-red-50 text-red-800',
  info: 'border-brand-200 bg-brand-50 text-brand-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
};

export interface AlertProps {
  tone?: AlertTone;
  children: ReactNode;
}

/**
 * A short message about the last action. `role="alert"` makes a screen
 * reader announce it as soon as it appears, which is what a failed login
 * needs — the message renders far from the button that caused it.
 */
export function Alert({ tone = 'error', children }: AlertProps) {
  return (
    <div role="alert" className={`rounded-lg border px-3 py-2.5 text-sm ${TONE_CLASSES[tone]}`}>
      {children}
    </div>
  );
}
