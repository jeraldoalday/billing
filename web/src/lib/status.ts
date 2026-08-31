import type { BadgeTone } from '../components/Badge';

/**
 * Which colour a status is shown in.
 *
 * Subscriptions, invoices, and payments each have their own status enum,
 * but a person reading the console does not care which table a value came
 * from — they care whether it is fine, needs attention, or is over. The
 * mapping is therefore by meaning rather than by model, and lives in one
 * place so `PAST_DUE` cannot be amber on one page and red on another.
 */
const TONES: Record<string, BadgeTone> = {
  // Money is in, or the thing is running as intended.
  ACTIVE: 'success',
  PAID: 'success',
  SUCCEEDED: 'success',
  // Running, but not yet paying.
  TRIALING: 'info',
  OPEN: 'info',
  // Needs a human or a retry.
  PAST_DUE: 'warning',
  FAILED: 'danger',
  // Over, or not yet begun: an end state, not a problem to fix.
  CANCELED: 'neutral',
  VOID: 'neutral',
  DRAFT: 'neutral',
};

export function statusTone(status: string): BadgeTone {
  return TONES[status.toUpperCase()] ?? 'neutral';
}

/** The tone for a row that is simply switched off, e.g. an archived plan. */
export function activeTone(active: boolean): BadgeTone {
  return active ? 'success' : 'neutral';
}

export function activeLabel(active: boolean): string {
  return active ? 'Active' : 'Archived';
}
