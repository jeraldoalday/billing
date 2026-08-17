// SQLite has no native enum type (see prisma/schema.prisma), so Payment's
// `status` column is a plain string. This tuple is the single source of
// truth for the valid values. Unlike InvoiceStatus, a Payment is immutable
// once recorded — it's the outcome of one already-finished charge attempt
// sequence, not something that transitions afterward — so there's no state
// machine here, just the allowed set.

export const PAYMENT_STATUSES = ['SUCCEEDED', 'FAILED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
