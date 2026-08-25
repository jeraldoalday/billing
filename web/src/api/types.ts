/**
 * Types for the JSON the billing API returns.
 *
 * These mirror `server/prisma/schema.prisma` and the route handlers in
 * `server/src/routes/`, with two deliberate differences:
 *
 * - Every `DateTime` arrives as an ISO 8601 *string*, because that is what
 *   `JSON.stringify` produced on the way out. Nothing here is a `Date`;
 *   parsing happens at the edge where a value is formatted for display.
 * - Money is an integer count of minor currency units (cents), exactly as
 *   the server stores it. Never divide by 100 outside a formatter.
 */

export type BillingInterval = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
export type PricingModel = 'FLAT' | 'TIERED' | 'USAGE';
export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
export type InvoiceStatus = 'DRAFT' | 'OPEN' | 'PAID' | 'VOID';
export type InvoiceLineItemType = 'PLAN' | 'PRORATION' | 'USAGE' | 'DISCOUNT';
export type PaymentStatus = 'SUCCEEDED' | 'FAILED';

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

/** The body of `POST /auth/signup` and `POST /auth/login`. */
export interface AuthResult {
  token: string;
  user: User;
  organization: Organization;
}

/** The body of `GET /auth/me` — the same identity, without a fresh token. */
export interface Session {
  user: User;
  organization: Organization;
}

export interface Product {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PriceTier {
  id: string;
  planId: string;
  order: number;
  /** Inclusive upper bound of this band; `null` on the final, open band. */
  upTo: number | null;
  unitAmount: number;
  flatFee: number;
}

export interface Plan {
  id: string;
  organizationId: string;
  productId: string;
  name: string;
  pricingModel: PricingModel;
  interval: BillingInterval;
  currency: string;
  /** Set for FLAT plans only. */
  flatAmount: number | null;
  /** Set for USAGE and TIERED plans only. */
  usageMetric: string | null;
  /** Set for USAGE plans only; TIERED plans price through `tiers`. */
  usageUnitAmount: number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tiers?: PriceTier[];
}

export interface Customer {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  active: boolean;
  country: string | null;
  taxId: string | null;
  taxExempt: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  id: string;
  organizationId: string;
  customerId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEnd: string | null;
  /** A cancellation scheduled for the end of the current period. */
  cancelAt: string | null;
  /** When the subscription actually stopped. */
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
  plan?: Plan;
  customer?: Customer;
}

export interface InvoiceLineItem {
  id: string;
  invoiceId: string;
  type: InvoiceLineItemType;
  description: string;
  quantity: number;
  unitAmount: number;
  /** Signed: negative for a proration credit or a discount. */
  amount: number;
  createdAt: string;
}

export interface Invoice {
  id: string;
  organizationId: string;
  customerId: string;
  subscriptionId: string;
  /** Sequential per organization, e.g. `INV-0001`. Not the id. */
  number: string;
  status: InvoiceStatus;
  currency: string;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  /** `subtotal - discountAmount + taxAmount`. */
  total: number;
  issuedAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lineItems?: InvoiceLineItem[];
  customer?: Customer;
}

export interface PaymentMethod {
  id: string;
  organizationId: string;
  customerId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  organizationId: string;
  invoiceId: string;
  paymentMethodId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  attemptNumber: number;
  failureCode: string | null;
  createdAt: string;
}

export interface MrrBreakdownEntry {
  key: string;
  label: string;
  mrr: number;
  subscriptions: number;
}

export interface MrrReport {
  mrr: number;
  subscriptions: number;
  customers: number;
  /** Average revenue per paying customer, not per subscription. */
  arpu: number;
  groupBy: string;
  breakdown: MrrBreakdownEntry[];
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

export interface SummaryReport {
  mrr: MrrReport;
  churn: ChurnReport;
  revenue: RevenueReport;
}

/** The error envelope every failing endpoint returns. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * The `details` a 400 VALIDATION_ERROR carries: Zod's `flatten()` output.
 * Forms read `fieldErrors` to put a message under the offending input.
 */
export interface ValidationErrorDetails {
  formErrors: string[];
  fieldErrors: Record<string, string[] | undefined>;
}
