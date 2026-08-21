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

export async function listPaymentsForInvoice(organizationId: string, invoiceId: string) {
  await invoiceService.getInvoice(organizationId, invoiceId);

  return prisma.payment.findMany({
    where: { organizationId, invoiceId },
    orderBy: { createdAt: 'desc' },
  });
}
