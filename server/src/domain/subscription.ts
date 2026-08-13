import type { BillingInterval } from './pricing';

// SQLite has no native enum type (see prisma/schema.prisma), so
// Subscription's `status` column is a plain string. This tuple is the
// single source of truth for the valid values, consumed by Zod schemas
// (z.enum) and anywhere else that needs the allowed set at runtime.
export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// Advances `date` by one billing period of the given interval. MONTH/YEAR
// use the calendar (not a fixed day count), so a MONTH period starting on
// the 31st lands on the last day of the following month when that month is
// shorter (matches Date's native rollover-free clamping via setMonth/setDate
// order below rather than JS's default "overflow into the next month").
export function addInterval(date: Date, interval: BillingInterval, count = 1): Date {
  const result = new Date(date);

  switch (interval) {
    case 'DAY':
      result.setUTCDate(result.getUTCDate() + count);
      return result;
    case 'WEEK':
      result.setUTCDate(result.getUTCDate() + count * 7);
      return result;
    case 'MONTH':
      return addCalendarMonths(result, count);
    case 'YEAR':
      return addCalendarMonths(result, count * 12);
  }
}

function addCalendarMonths(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const result = new Date(date);
  // Pin to the 1st before shifting months so e.g. Jan 31 + 1 month can't
  // overflow into March; then clamp the day back to the target month's
  // actual length.
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const daysInTargetMonth = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, daysInTargetMonth));
  return result;
}
