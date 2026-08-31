import type { ReactNode } from 'react';
import { humanizeStatus } from '../lib/format';
import { statusTone } from '../lib/status';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  info: 'bg-brand-50 text-brand-800 ring-brand-200',
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  danger: 'bg-red-50 text-red-800 ring-red-200',
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export interface StatusBadgeProps {
  /** A SCREAMING_SNAKE status straight from the API. */
  status: string;
}

/**
 * A status exactly as the API returned it, humanized and coloured by what
 * it means. Taking the raw value keeps the page from having to remember
 * both the label and the tone at every call site.
 */
export function StatusBadge({ status }: StatusBadgeProps) {
  return <Badge tone={statusTone(status)}>{humanizeStatus(status)}</Badge>;
}
