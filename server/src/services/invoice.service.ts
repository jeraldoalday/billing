import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { calculateTax } from '../domain/tax';
import {
  canTransitionInvoiceStatus,
  formatInvoiceNumber,
  sumLineItemAmounts,
  type InvoiceStatus,
} from '../domain/invoice';
import { periodAmountForProration } from '../domain/proration';
import * as subscriptionService from './subscription.service';
import type { GenerateInvoiceInput, ListInvoicesQuery } from '../validators/invoice';

const WITH_LINE_ITEMS = { lineItems: true };

interface DraftLineItem {
  type: 'PLAN' | 'PRORATION';
  description: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  subscriptionEventId?: string;
}

// The plan's recurring price for the period, as a single line item. Only
// FLAT plans have a fixed amount known up front; TIERED/USAGE plans bill
// based on metered consumption at period end, which Day 7 wires in — until
// then they simply contribute no plan line item (an invoice for a pure
// usage-based subscription may legitimately have $0 subtotal here).
function planLineItem(plan: {
  name: string;
  interval: string;
  pricingModel: string;
  flatAmount: number | null;
}): DraftLineItem | null {
  const amount = periodAmountForProration(plan);
  if (amount <= 0) {
    return null;
  }
  return {
    type: 'PLAN',
    description: `${plan.name} (${plan.interval.toLowerCase()}ly)`,
    quantity: 1,
    unitAmount: amount,
    amount,
  };
}

// Turns any not-yet-invoiced PLAN_CHANGED SubscriptionEvent for this
// subscription into a proration line item. "Not-yet-invoiced" is tracked by
// the InvoiceLineItem.subscriptionEventId back-reference (see
// prisma/schema.prisma) rather than a date-range check, so a proration from
// any period is picked up exactly once regardless of how invoice generation
// timing lines up with when the plan change happened.
async function uninvoicedProrationLineItems(subscriptionId: string): Promise<DraftLineItem[]> {
  const events = await prisma.subscriptionEvent.findMany({
    where: {
      subscriptionId,
      type: 'PLAN_CHANGED',
      prorationAmount: { not: null },
      invoiceLineItem: null,
    },
    orderBy: { createdAt: 'asc' },
  });

  return events
    .filter((event) => event.prorationAmount !== null && event.prorationAmount !== 0)
    .map((event) => ({
      type: 'PRORATION' as const,
      description:
        (event.prorationAmount ?? 0) > 0
          ? 'Proration charge for plan change'
          : 'Proration credit for plan change',
      quantity: 1,
      unitAmount: event.prorationAmount ?? 0,
      amount: event.prorationAmount ?? 0,
      subscriptionEventId: event.id,
    }));
}

// Generates a DRAFT invoice for a subscription's current billing period:
// the plan's recurring price plus any proration carried over from mid-period
// plan changes since the last invoice. Refuses to double-invoice the same
// period (only one non-VOID invoice may exist per subscription per period).
export async function generateInvoice(organizationId: string, input: GenerateInvoiceInput) {
  const subscription = await subscriptionService.getSubscription(
    organizationId,
    input.subscriptionId,
  );

  if (subscription.status === 'CANCELED') {
    throw ApiError.badRequest('Cannot generate an invoice for a canceled subscription');
  }

  const existing = await prisma.invoice.findFirst({
    where: {
      subscriptionId: subscription.id,
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      status: { not: 'VOID' },
    },
  });
  if (existing) {
    throw ApiError.conflict("An invoice already exists for this subscription's current period");
  }

  const lineItems: DraftLineItem[] = [];
  const plan = planLineItem(subscription.plan);
  if (plan) {
    lineItems.push(plan);
  }
  lineItems.push(...(await uninvoicedProrationLineItems(subscription.id)));

  const subtotal = sumLineItemAmounts(lineItems);
  const taxAmount = calculateTax(subtotal, subscription.customer.country);
  const total = subtotal + taxAmount;

  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.update({
      where: { id: organizationId },
      data: { invoiceSequence: { increment: 1 } },
    });

    return tx.invoice.create({
      data: {
        organizationId,
        customerId: subscription.customerId,
        subscriptionId: subscription.id,
        number: formatInvoiceNumber(organization.invoiceSequence),
        status: 'DRAFT',
        currency: subscription.plan.currency,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
        subtotal,
        taxAmount,
        total,
        lineItems: { create: lineItems },
      },
      include: WITH_LINE_ITEMS,
    });
  });
}

export async function listInvoices(organizationId: string, query: ListInvoicesQuery) {
  return prisma.invoice.findMany({
    where: {
      organizationId,
      customerId: query.customerId,
      subscriptionId: query.subscriptionId,
      status: query.status,
    },
    include: WITH_LINE_ITEMS,
    orderBy: { createdAt: 'desc' },
  });
}

// Scoping the lookup to organizationId means an invoice belonging to another
// org 404s exactly like one that doesn't exist, rather than leaking a 403
// that would confirm the id is real.
export async function getInvoice(organizationId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: WITH_LINE_ITEMS,
  });

  if (!invoice) {
    throw ApiError.notFound('Invoice not found');
  }

  return invoice;
}

type TransitionTimestamp = { issuedAt: Date } | { paidAt: Date } | { voidedAt: Date };

async function transitionInvoice(
  organizationId: string,
  invoiceId: string,
  to: InvoiceStatus,
  timestamp: TransitionTimestamp,
) {
  const invoice = await getInvoice(organizationId, invoiceId);
  const from = invoice.status as InvoiceStatus;

  if (!canTransitionInvoiceStatus(from, to)) {
    throw ApiError.conflict(`Cannot move an invoice from ${from} to ${to}`);
  }

  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: to, ...timestamp },
    include: WITH_LINE_ITEMS,
  });
}

// DRAFT -> OPEN: the invoice is issued to the customer and its amounts are
// now final (a DRAFT can still be regenerated/voided freely; an OPEN one is
// the thing Day 6's payment gateway will actually try to charge).
export function finalizeInvoice(organizationId: string, invoiceId: string) {
  return transitionInvoice(organizationId, invoiceId, 'OPEN', { issuedAt: new Date() });
}

// OPEN -> PAID: records that the invoice was paid. This is a manual/
// administrative marking for Day 5; Day 6 wires it to an actual payment
// gateway charge outcome instead of a direct API call.
export function markInvoicePaid(organizationId: string, invoiceId: string) {
  return transitionInvoice(organizationId, invoiceId, 'PAID', { paidAt: new Date() });
}

// DRAFT|OPEN -> VOID: cancels an invoice that should never be collected
// (generated in error, or superseded). Terminal, like PAID.
export function voidInvoice(organizationId: string, invoiceId: string) {
  return transitionInvoice(organizationId, invoiceId, 'VOID', { voidedAt: new Date() });
}
