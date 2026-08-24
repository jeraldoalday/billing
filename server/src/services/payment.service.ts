import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { detectCardBrand, isCardExpired, lastFour } from '../domain/card';
import { isRetriableFailureCode, MockPaymentGateway, type ChargeResult, type PaymentGateway } from '../lib/paymentGateway';
import { retryWithBackoff } from '../lib/retry';
import { logger } from '../lib/logger';
import * as customerService from './customer.service';
import * as dunningService from './dunning.service';
import * as invoiceService from './invoice.service';
import * as webhookService from './webhook.service';
import type { CreatePaymentMethodInput, ListPaymentMethodsQuery } from '../validators/paymentMethod';
import type { ChargeInvoiceInput } from '../validators/payment';

// A logical charge (one call to chargeInvoice) makes at most this many
// attempts against the gateway before giving up, backing off between each.
// Not configurable per-call for now — every invoice gets the same retry
// policy, matching how the rest of this service has no per-tenant knobs yet.
const MAX_CHARGE_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 25;

const defaultGateway: PaymentGateway = new MockPaymentGateway();

export async function addPaymentMethod(organizationId: string, input: CreatePaymentMethodInput) {
  // Also confirms the customer belongs to this org (404s otherwise), so a
  // payment method can never be attached to another org's customer.
  await customerService.getCustomer(organizationId, input.customerId);

  if (isCardExpired(input.expMonth, input.expYear)) {
    throw ApiError.badRequest('Card expiration date is in the past');
  }

  const brand = detectCardBrand(input.cardNumber);
  const last4 = lastFour(input.cardNumber);

  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.paymentMethod.updateMany({
        where: { customerId: input.customerId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return tx.paymentMethod.create({
      data: {
        organizationId,
        customerId: input.customerId,
        brand,
        last4,
        expMonth: input.expMonth,
        expYear: input.expYear,
        isDefault: input.isDefault ?? false,
      },
    });
  });
}

// The card an automatic charge should use: the customer's default, or
// their most recently added one if none is marked default (a customer who
// added a card before defaults existed still deserves to be billed).
// Shared by dunning retries (src/services/dunning.service.ts) and the
// recurring billing runner (src/services/billing.service.ts), which have to
// agree on what "the customer's card" means — a retry that charged a
// different card than the run it is recovering would be a surprise on a
// statement.
export async function defaultPaymentMethodFor(organizationId: string, customerId: string) {
  return prisma.paymentMethod.findFirst({
    where: { organizationId, customerId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function listPaymentMethods(organizationId: string, query: ListPaymentMethodsQuery) {
  return prisma.paymentMethod.findMany({
    where: { organizationId, customerId: query.customerId },
    orderBy: { createdAt: 'desc' },
  });
}

// Scoping the lookup to organizationId means a payment method belonging to
// another org 404s exactly like one that doesn't exist, rather than leaking
// a 403 that would confirm the id is real.
export async function getPaymentMethod(organizationId: string, paymentMethodId: string) {
  const paymentMethod = await prisma.paymentMethod.findFirst({
    where: { id: paymentMethodId, organizationId },
  });

  if (!paymentMethod) {
    throw ApiError.notFound('Payment method not found');
  }

  return paymentMethod;
}

// Attempts to charge an OPEN invoice against a payment method, retrying
// transient gateway failures (see src/lib/paymentGateway.ts) with backoff
// before giving up. Always records exactly one Payment row per call,
// reflecting the *final* outcome and how many gateway attempts it took —
// individual retried attempts aren't persisted separately, since they're not
// independently meaningful (a caller only ever cares "did this charge
// succeed, and if not, is it worth trying again"). On success, transitions
// the invoice OPEN -> PAID; on failure, the invoice is left OPEN so it can
// be retried later (e.g. by Day 8's dunning flow) or charged with a
// different payment method — and a failure is what opens (or advances) the
// invoice's dunning campaign in src/services/dunning.service.ts, so a
// declined charge is automatically retried on the Day 8 schedule instead of
// needing anyone to notice.
export async function chargeInvoice(
  organizationId: string,
  invoiceId: string,
  input: ChargeInvoiceInput,
  gateway: PaymentGateway = defaultGateway,
) {
  const invoice = await invoiceService.getInvoice(organizationId, invoiceId);
  if (invoice.status !== 'OPEN') {
    throw ApiError.conflict(`Cannot charge an invoice with status ${invoice.status}`);
  }

  const paymentMethod = await getPaymentMethod(organizationId, input.paymentMethodId);
  if (paymentMethod.customerId !== invoice.customerId) {
    throw ApiError.badRequest('Payment method does not belong to the invoice customer');
  }

  // An invoice with nothing left to collect — a 100%-off coupon (Day 9), or
  // a period whose proration credits cancelled the plan charge out — is
  // settled without touching the gateway. Processors reject zero-value
  // authorizations, so sending one would leave a genuinely paid-up invoice
  // OPEN and hand it to dunning to retry forever.
  if (invoice.total <= 0) {
    return settleWithoutCharge(organizationId, invoice, paymentMethod.id);
  }

  let attemptsMade = 0;
  const outcome = await retryWithBackoff<ChargeResult>(
    async (attemptNumber) => {
      attemptsMade = attemptNumber;
      return gateway.charge({
        last4: paymentMethod.last4,
        amount: invoice.total,
        currency: invoice.currency,
        attempt: attemptNumber,
      });
    },
    {
      maxAttempts: MAX_CHARGE_ATTEMPTS,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      isRetriable: (result) => result.status === 'declined' && isRetriableFailureCode(result.failureCode),
    },
  );

  const payment = await prisma.payment.create({
    data: {
      organizationId,
      invoiceId: invoice.id,
      paymentMethodId: paymentMethod.id,
      amount: invoice.total,
      currency: invoice.currency,
      status: outcome.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
      attemptNumber: attemptsMade,
      failureCode: outcome.status === 'declined' ? outcome.failureCode : null,
    },
  });

  if (outcome.status === 'succeeded') {
    await invoiceService.markInvoicePaid(organizationId, invoice.id);
    await webhookService.emitEvent(organizationId, 'payment.succeeded', {
      paymentId: payment.id,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      amount: payment.amount,
      currency: payment.currency,
    });
  } else {
    await webhookService.emitEvent(organizationId, 'payment.failed', {
      paymentId: payment.id,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      amount: payment.amount,
      currency: payment.currency,
      failureCode: payment.failureCode,
      attemptNumber: payment.attemptNumber,
    });

    // Opening the campaign must never turn a recorded decline into a failed
    // request: the Payment row is already written and is what the caller
    // asked for. A campaign that couldn't be opened is logged and picked up
    // by the next failed charge.
    try {
      await dunningService.startDunning(organizationId, invoice.id, {
        failureCode: payment.failureCode,
      });
    } catch (err) {
      logger.error({ err, invoiceId: invoice.id }, 'Failed to start dunning for a declined invoice');
    }
  }

  return payment;
}

// Records a zero-amount SUCCEEDED Payment and marks the invoice paid.
// `attemptNumber` is 0 to say plainly that no gateway attempt was made,
// which is what tells this apart from a real charge that happened to be for
// nothing.
async function settleWithoutCharge(
  organizationId: string,
  invoice: { id: string; customerId: string; total: number; currency: string },
  paymentMethodId: string,
) {
  const payment = await prisma.payment.create({
    data: {
      organizationId,
      invoiceId: invoice.id,
      paymentMethodId,
      amount: invoice.total,
      currency: invoice.currency,
      status: 'SUCCEEDED',
      attemptNumber: 0,
    },
  });

  await invoiceService.markInvoicePaid(organizationId, invoice.id);
  await webhookService.emitEvent(organizationId, 'payment.succeeded', {
    paymentId: payment.id,
    invoiceId: invoice.id,
    customerId: invoice.customerId,
    amount: payment.amount,
    currency: payment.currency,
  });

  return payment;
}

export async function listPaymentsForInvoice(organizationId: string, invoiceId: string) {
  await invoiceService.getInvoice(organizationId, invoiceId);

  return prisma.payment.findMany({
    where: { organizationId, invoiceId },
    orderBy: { createdAt: 'desc' },
  });
}
