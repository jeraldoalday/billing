import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { calculateCustomerTax } from '../domain/tax';
import {
  canTransitionInvoiceStatus,
  composeInvoiceAmounts,
  formatInvoiceNumber,
  sumLineItemAmounts,
  type InvoiceStatus,
} from '../domain/invoice';
import {
  calculateDiscountAmount,
  couponAppliesToPeriod,
  couponMatchesCurrency,
  describeCoupon,
} from '../domain/coupon';
import { periodAmountForProration } from '../domain/proration';
import { calculateUsageAmount } from '../domain/usage';
import * as couponService from './coupon.service';
import * as dunningService from './dunning.service';
import * as subscriptionService from './subscription.service';
import * as usageService from './usage.service';
import * as webhookService from './webhook.service';
import type { GenerateInvoiceInput, ListInvoicesQuery } from '../validators/invoice';

const WITH_LINE_ITEMS = { lineItems: true };

interface DraftLineItem {
  type: 'PLAN' | 'PRORATION' | 'USAGE' | 'DISCOUNT';
  description: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  subscriptionEventId?: string;
}

// The plan's recurring price for the period, as a single line item. Only
// FLAT plans have a fixed amount known up front; TIERED/USAGE plans bill
// based on metered consumption at period end (see usageLineItem below), so
// they simply contribute no plan line item here (an invoice for a pure
// usage-based subscription may legitimately have $0 from this line).
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

// The charge for metered consumption during the period, as a single line
// item. Only applies to USAGE/TIERED plans (a FLAT plan has no
// `usageMetric` and contributes nothing here); aggregates UsageEvent rows
// scoped to this subscription and the plan's metric over
// [currentPeriodStart, currentPeriodEnd), matching how
// src/services/usage.service.ts treats every other period aggregation in
// this codebase. Generating no more than one non-VOID invoice per period
// (enforced by generateInvoice below) is what keeps the same usage from
// ever being billed twice.
async function usageLineItem(subscription: {
  id: string;
  organizationId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  plan: {
    pricingModel: string;
    usageMetric: string | null;
    usageUnitAmount: number | null;
    tiers: { order: number; upTo: number | null; unitAmount: number; flatFee: number }[];
  };
}): Promise<DraftLineItem | null> {
  const { plan } = subscription;
  if (plan.pricingModel === 'FLAT' || !plan.usageMetric) {
    return null;
  }

  const quantity = await usageService.sumUsageForMetric(
    subscription.organizationId,
    subscription.id,
    plan.usageMetric,
    subscription.currentPeriodStart,
    subscription.currentPeriodEnd,
  );
  if (quantity <= 0) {
    return null;
  }

  const amount = calculateUsageAmount(plan, plan.tiers, quantity);
  if (amount <= 0) {
    return null;
  }

  return {
    type: 'USAGE',
    description: `${plan.usageMetric} usage (${quantity} units)`,
    quantity,
    // Graduated tiering doesn't have a single per-unit rate, so the
    // recorded unitAmount is the effective average for display purposes
    // only — `amount` (the actual charge) is always computed independently.
    unitAmount:
      plan.pricingModel === 'USAGE' ? (plan.usageUnitAmount ?? 0) : Math.round(amount / quantity),
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
  // A trialing subscription hasn't started paying yet, so its period
  // generates no PLAN charge (an invoice with only proration/usage line
  // items, or none at all, is still valid to draft — e.g. a plan change
  // made mid-trial for when the trial ends).
  const isTrialing = subscription.status === 'TRIALING';
  const plan = isTrialing ? null : planLineItem(subscription.plan);
  if (plan) {
    lineItems.push(plan);
  }
  // A trialing subscription hasn't started paying for consumption either,
  // matching how the PLAN line item is skipped above.
  const usage = isTrialing ? null : await usageLineItem(subscription);
  if (usage) {
    lineItems.push(usage);
  }
  lineItems.push(...(await uninvoicedProrationLineItems(subscription.id)));

  const subtotal = sumLineItemAmounts(lineItems);

  // The coupon (if any) discounting this subscription right now. Its period
  // is consumed inside the same transaction that writes the invoice below,
  // so a discount is never handed out without being counted against the
  // redemption's duration.
  const redemption = await applicableRedemption(organizationId, subscription);
  const discountAmount = redemption ? calculateDiscountAmount(redemption.coupon, subtotal) : 0;
  if (redemption && discountAmount > 0) {
    lineItems.push({
      type: 'DISCOUNT',
      description: `${redemption.coupon.code} (${describeCoupon(redemption.coupon)})`,
      quantity: 1,
      unitAmount: -discountAmount,
      amount: -discountAmount,
    });
  }

  const { taxAmount, total } = composeInvoiceAmounts({
    subtotal,
    discountAmount,
    taxAmount: calculateCustomerTax(subtotal - discountAmount, subscription.customer).amount,
  });

  const invoice = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.update({
      where: { id: organizationId },
      data: { invoiceSequence: { increment: 1 } },
    });

    const created = await tx.invoice.create({
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
        discountAmount,
        taxAmount,
        total,
        lineItems: { create: lineItems },
      },
      include: WITH_LINE_ITEMS,
    });

    // A redemption that produced no discount (nothing to discount on a zero
    // subtotal) hasn't been used up, so it keeps its remaining periods for
    // the next invoice that actually charges something.
    if (redemption && discountAmount > 0) {
      await couponService.consumeRedemptionPeriod(tx, redemption);
    }

    return created;
  });

  await webhookService.emitEvent(organizationId, 'invoice.created', invoiceEventData(invoice));

  return invoice;
}

// The redemption to apply to the invoice being generated, or null. A
// redemption whose duration is spent, or whose amount-off coupon is in a
// different currency than the invoice, discounts nothing — the currency
// can't change after redemption today, but plans can be repriced, and
// silently converting between currencies would be worse than not
// discounting.
async function applicableRedemption(
  organizationId: string,
  subscription: { id: string; plan: { currency: string } },
) {
  const redemption = await couponService.getActiveRedemption(organizationId, subscription.id);
  if (!redemption) {
    return null;
  }
  if (!couponAppliesToPeriod(redemption.coupon, redemption.periodsApplied)) {
    return null;
  }
  if (!couponMatchesCurrency(redemption.coupon, subscription.plan.currency)) {
    return null;
  }
  return redemption;
}

// The shape every invoice.* event carries. Deliberately a summary rather
// than the whole row: a receiver that needs line items can fetch the invoice
// by id, and keeping payloads small keeps them cheap to store and re-sign
// for every retry.
function invoiceEventData(invoice: {
  id: string;
  number: string;
  status: string;
  customerId: string;
  subscriptionId: string;
  currency: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
}) {
  return {
    invoiceId: invoice.id,
    number: invoice.number,
    status: invoice.status,
    customerId: invoice.customerId,
    subscriptionId: invoice.subscriptionId,
    currency: invoice.currency,
    subtotal: invoice.subtotal,
    discountAmount: invoice.discountAmount,
    taxAmount: invoice.taxAmount,
    total: invoice.total,
  };
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
export async function finalizeInvoice(organizationId: string, invoiceId: string) {
  const invoice = await transitionInvoice(organizationId, invoiceId, 'OPEN', { issuedAt: new Date() });
  await webhookService.emitEvent(organizationId, 'invoice.finalized', invoiceEventData(invoice));
  return invoice;
}

// OPEN -> PAID: records that the invoice was paid, whether by Day 6's
// gateway charge or by an administrative marking.
export async function markInvoicePaid(organizationId: string, invoiceId: string) {
  const invoice = await transitionInvoice(organizationId, invoiceId, 'PAID', { paidAt: new Date() });
  await webhookService.emitEvent(organizationId, 'invoice.paid', invoiceEventData(invoice));
  // However the invoice got settled, any recovery campaign for it is over —
  // this is the single transition every settlement passes through, so the
  // subscription leaves PAST_DUE immediately instead of at the next sweep.
  await dunningService.recoverDunningForInvoice(organizationId, invoice.id);
  return invoice;
}

// DRAFT|OPEN -> VOID: cancels an invoice that should never be collected
// (generated in error, or superseded). Terminal, like PAID.
export async function voidInvoice(organizationId: string, invoiceId: string) {
  const invoice = await transitionInvoice(organizationId, invoiceId, 'VOID', { voidedAt: new Date() });
  await webhookService.emitEvent(organizationId, 'invoice.voided', invoiceEventData(invoice));
  return invoice;
}
