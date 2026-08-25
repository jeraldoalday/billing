/**
 * Display formatting for values the API returns.
 *
 * The API speaks in integer minor units and ISO strings; this module is the
 * only place either is turned into something a person reads, so a currency
 * or a date never gets formatted two slightly different ways in two pages.
 */

/**
 * Formats an integer minor-unit amount, e.g. `1999` and `"usd"` becomes
 * `$19.99`. The exponent comes from `Intl` rather than a hardcoded 100, so
 * zero-decimal currencies like JPY are not divided into cents that do not
 * exist.
 */
export function formatMoney(minorUnits: number, currency = 'usd', locale = 'en-US'): string {
  const code = currency.toUpperCase();
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: code });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(minorUnits / 10 ** digits);
}

/** A ratio (`0.0731`) as a percentage string (`7.31%`). */
export function formatPercent(ratio: number, fractionDigits = 2): string {
  if (!Number.isFinite(ratio)) {
    return '—';
  }
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

/** An ISO timestamp as a short calendar date, e.g. `25 Aug 2026`. */
export function formatDate(iso: string | null | undefined, locale = 'en-GB'): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Whole days from `now` until `iso`; negative once it is in the past. */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) {
    return 0;
  }
  return Math.round((target - now.getTime()) / 86_400_000);
}

/** Pluralizes a count for display: `1 invoice`, `3 invoices`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Human-readable form of a SCREAMING_SNAKE status, e.g. `PAST_DUE` becomes
 * `Past due`, for statuses the UI shows verbatim from the API.
 */
export function humanizeStatus(status: string): string {
  const words = status.toLowerCase().split('_');
  const [first = '', ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/** Initials for an avatar chip, from a name or, failing that, an email. */
export function initialsFor(name: string | null | undefined, email: string): string {
  const source = name?.trim() || email.split('@')[0] || '?';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase());
  return letters.join('') || '?';
}
