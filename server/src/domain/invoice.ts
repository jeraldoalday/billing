// SQLite has no native enum type (see prisma/schema.prisma), so Invoice's
// `status` and InvoiceLineItem's `type` columns are plain strings. These
// tuples are the single source of truth for the valid values, consumed by
// Zod schemas (z.enum) and anywhere else that needs the allowed set at
// runtime. InvoiceLineItemType's USAGE covers metered consumption on a
// USAGE/TIERED plan, aggregated from UsageEvent rows by
// src/services/invoice.service.ts (Day 7).

export const INVOICE_STATUSES = ['DRAFT', 'OPEN', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_LINE_ITEM_TYPES = ['PLAN', 'PRORATION', 'USAGE'] as const;
export type InvoiceLineItemType = (typeof INVOICE_LINE_ITEM_TYPES)[number];

// The invoice status state machine: DRAFT -> OPEN -> PAID | VOID. An invoice
// can also be voided before it's ever issued (DRAFT -> VOID, e.g. generated
// in error). PAID and VOID are terminal — neither has any outgoing edge, so
// a paid invoice can't be voided and a voided one can't be revived.
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  DRAFT: ['OPEN', 'VOID'],
  OPEN: ['PAID', 'VOID'],
  PAID: [],
  VOID: [],
};

export function canTransitionInvoiceStatus(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface InvoiceLineItemAmount {
  amount: number;
}

// Sums signed line item amounts (a PRORATION line item may be negative, a
// credit) into an invoice subtotal. Pure so it's independently testable from
// how the service assembles line items.
export function sumLineItemAmounts(lineItems: readonly InvoiceLineItemAmount[]): number {
  return lineItems.reduce((sum, item) => sum + item.amount, 0);
}

// Formats an Organization.invoiceSequence value into the customer-facing
// invoice number. Zero-padded to 6 digits so numbers sort and align
// visually for as long as an org realistically stays under a million
// invoices; beyond that it just grows past the padding rather than
// truncating or colliding.
export function formatInvoiceNumber(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new Error('sequence must be a positive integer');
  }
  return `INV-${String(sequence).padStart(6, '0')}`;
}
