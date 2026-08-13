// Pure proration math for switching a subscription's plan mid-period. No I/O,
// no Prisma types — takes plain values so it's trivially unit-testable and
// reusable once Day 5's invoicing engine needs to turn this into line items.
//
// Model: the old plan's recurring amount is credited for the unused portion
// of the current period, and the new plan's recurring amount is charged for
// that same remaining portion. Amounts are integer minor currency units
// (e.g. cents); both are rounded to the nearest whole unit independently,
// then netted, matching how most billing systems avoid carrying fractional
// cents across the boundary.
export interface ProrationInput {
  periodStart: Date;
  periodEnd: Date;
  changeAt: Date;
  oldPeriodAmount: number;
  newPeriodAmount: number;
}

export interface ProrationResult {
  /** Unused portion of the old plan's amount, owed back to the customer. */
  creditAmount: number;
  /** Remaining-period portion of the new plan's amount, owed by the customer. */
  chargeAmount: number;
  /** chargeAmount - creditAmount. Positive: customer owes more. Negative: customer is credited. */
  netAmount: number;
  /** Fraction of the period (0..1) remaining at changeAt, used to derive both amounts. */
  remainingFraction: number;
}

export function calculateProration(input: ProrationInput): ProrationResult {
  const { periodStart, periodEnd, changeAt, oldPeriodAmount, newPeriodAmount } = input;

  const totalMs = periodEnd.getTime() - periodStart.getTime();
  if (totalMs <= 0) {
    throw new Error('periodEnd must be after periodStart');
  }

  // Clamp changeAt into [periodStart, periodEnd]: a change requested outside
  // the period (e.g. backdated, or applied late by a caller) still produces
  // a well-defined result instead of a negative or >100% fraction.
  const clampedChangeMs = Math.min(Math.max(changeAt.getTime(), periodStart.getTime()), periodEnd.getTime());
  const remainingMs = periodEnd.getTime() - clampedChangeMs;
  const remainingFraction = remainingMs / totalMs;

  const creditAmount = Math.round(oldPeriodAmount * remainingFraction);
  const chargeAmount = Math.round(newPeriodAmount * remainingFraction);

  return {
    creditAmount,
    chargeAmount,
    netAmount: chargeAmount - creditAmount,
    remainingFraction,
  };
}
