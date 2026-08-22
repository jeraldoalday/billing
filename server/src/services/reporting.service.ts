import { prisma } from '../lib/prisma';
import {
  calculateArpu,
  calculateChurnRate,
  calculateRetentionRate,
  cohortForWindow,
  summarizeMrr,
  wasLiveAt,
  type MrrBreakdownEntry,
} from '../domain/reporting';
import { couponAppliesToPeriod } from '../domain/coupon';
import type { MrrQuery, ReportWindowQuery } from '../validators/report';

// Revenue reporting: MRR and ARPU as live snapshots, churn and collected
// revenue over a window. Every figure is derived from the same subscription,
// invoice and coupon rows the rest of the platform bills from — nothing here
// is stored or cached, so a report can never drift from what was actually
// charged.
//
// MRR and ARPU deliberately have no `asOf`: reconstructing what a
// subscription's plan and discount were at a past instant would need
// history this schema doesn't keep (a plan's price is mutable), and a figure
// that silently answered a slightly different question than it was asked
// would be worse than not offering it.

const REVENUE_STATUSES = ['ACTIVE', 'PAST_DUE'];

// Subscriptions that are currently billing, with everything MRR needs:
// their plan's price and the coupon still discounting it.
async function revenueSubscriptions(organizationId: string) {
  const subscriptions = await prisma.subscription.findMany({
    where: { organizationId, status: { in: REVENUE_STATUSES } },
    include: {
      plan: true,
      couponRedemptions: { where: { status: 'ACTIVE' }, include: { coupon: true } },
    },
  });

  return subscriptions.map((subscription) => {
    // A redemption whose duration is spent stops counting against MRR even
    // before the next invoice generation moves it to COMPLETED, so the
    // report matches what the customer will actually be charged next.
    const redemption = subscription.couponRedemptions.find((candidate) =>
      couponAppliesToPeriod(candidate.coupon, candidate.periodsApplied),
    );
    return { ...subscription, discount: redemption?.coupon ?? null };
  });
}

export interface MrrReport {
  mrr: number;
  subscriptions: number;
  customers: number;
  arpu: number;
  groupBy: string;
  breakdown: MrrBreakdownEntry[];
}

// Monthly recurring revenue right now, plus the ARPU that falls out of it.
// ARPU is per paying *customer*, not per subscription: a customer on three
// subscriptions is one account, and counting them three times would flatter
// the figure.
export async function getMrrReport(organizationId: string, query: MrrQuery): Promise<MrrReport> {
  const subscriptions = await revenueSubscriptions(organizationId);

  const summary = summarizeMrr(subscriptions, (subscription) => {
    switch (query.groupBy) {
      case 'interval':
        return { key: subscription.plan.interval, label: subscription.plan.interval };
      case 'currency':
        return { key: subscription.plan.currency, label: subscription.plan.currency.toUpperCase() };
      default:
        return { key: subscription.planId, label: subscription.plan.name };
    }
  });

  const customers = new Set(subscriptions.map((subscription) => subscription.customerId)).size;

  return {
    mrr: summary.mrr,
    subscriptions: summary.subscriptions,
    customers,
    arpu: calculateArpu(summary.mrr, customers),
    groupBy: query.groupBy,
    breakdown: summary.breakdown,
  };
}

export interface ChurnReport {
  from: string;
  to: string;
  subscriptions: {
    atStart: number;
    churned: number;
    churnRate: number;
    retentionRate: number;
  };
  customers: {
    atStart: number;
    churned: number;
    churnRate: number;
  };
}

// Churn over [from, to), reported for subscriptions and for customers,
// because they answer different questions: a customer who drops one of
// three subscriptions is subscription churn but not customer churn, and
// only the second means the relationship ended.
export async function getChurnReport(
  organizationId: string,
  window: ReportWindowQuery,
): Promise<ChurnReport> {
  const subscriptions = await prisma.subscription.findMany({
    where: { organizationId },
    select: { id: true, customerId: true, createdAt: true, canceledAt: true },
  });

  const { atStart, churned } = cohortForWindow(subscriptions, window.from, window.to);

  // A customer is in the starting cohort if anything of theirs was live
  // then, and has churned only if nothing of theirs is live at the end —
  // switching plans mid-window (cancel one, start another) is not churn.
  const customersAtStart = new Set(atStart.map((subscription) => subscription.customerId));
  const customersLiveAtEnd = new Set(
    subscriptions
      .filter((subscription) => wasLiveAt(subscription, window.to))
      .map((subscription) => subscription.customerId),
  );
  const churnedCustomers = [...customersAtStart].filter(
    (customerId) => !customersLiveAtEnd.has(customerId),
  );

  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    subscriptions: {
      atStart: atStart.length,
      churned: churned.length,
      churnRate: calculateChurnRate({ atStart: atStart.length, churned: churned.length }),
      retentionRate: calculateRetentionRate({ atStart: atStart.length, churned: churned.length }),
    },
    customers: {
      atStart: customersAtStart.size,
      churned: churnedCustomers.length,
      churnRate: calculateChurnRate({
        atStart: customersAtStart.size,
        churned: churnedCustomers.length,
      }),
    },
  };
}

export interface RevenueReport {
  from: string;
  to: string;
  invoices: number;
  grossRevenue: number;
  discounts: number;
  tax: number;
  netRevenue: number;
  outstanding: number;
}

// Money actually collected over [from, to), from paid invoices. `paidAt` is
// the window's axis rather than `createdAt`, since revenue is recognized
// when it's collected — an invoice issued in one month and paid in the next
// belongs to the month it was paid in.
//
// `netRevenue` is what was collected net of tax (which is owed onward to a
// tax authority, not revenue), and `outstanding` is what's issued but still
// unpaid at the end of the window — the two figures anyone reading a
// revenue report next asks for.
export async function getRevenueReport(
  organizationId: string,
  window: ReportWindowQuery,
): Promise<RevenueReport> {
  const paid = await prisma.invoice.aggregate({
    where: {
      organizationId,
      status: 'PAID',
      paidAt: { gte: window.from, lt: window.to },
    },
    _count: { _all: true },
    _sum: { total: true, subtotal: true, discountAmount: true, taxAmount: true },
  });

  const outstanding = await prisma.invoice.aggregate({
    where: {
      organizationId,
      status: 'OPEN',
      issuedAt: { lt: window.to },
    },
    _sum: { total: true },
  });

  const grossRevenue = paid._sum.total ?? 0;
  const tax = paid._sum.taxAmount ?? 0;

  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    invoices: paid._count._all,
    grossRevenue,
    discounts: paid._sum.discountAmount ?? 0,
    tax,
    netRevenue: grossRevenue - tax,
    outstanding: outstanding._sum.total ?? 0,
  };
}

export interface SummaryReport {
  mrr: MrrReport;
  churn: ChurnReport;
  revenue: RevenueReport;
}

// Everything a dashboard needs in one request, so a caller doesn't have to
// fan out to three endpoints and reconcile three slightly different clocks.
export async function getSummaryReport(
  organizationId: string,
  window: ReportWindowQuery,
): Promise<SummaryReport> {
  const [mrr, churn, revenue] = await Promise.all([
    getMrrReport(organizationId, { groupBy: 'plan' }),
    getChurnReport(organizationId, window),
    getRevenueReport(organizationId, window),
  ]);

  return { mrr, churn, revenue };
}
