import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import type { ChargeRequest, ChargeResult, PaymentGateway } from '../lib/paymentGateway';
import { createCoupon, redeemCoupon } from './coupon.service';
import { createCustomer } from './customer.service';
import { finalizeInvoice, generateInvoice, getInvoice } from './invoice.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import { createSubscription } from './subscription.service';
import { addPaymentMethod, chargeInvoice, getPaymentMethod, listPaymentMethods, listPaymentsForInvoice } from './payment.service';

async function resetDb() {
  await prisma.couponRedemption.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.paymentMethod.deleteMany();
  await prisma.invoiceLineItem.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.product.deleteMany();
  await prisma.organization.deleteMany();
}

async function makeOrg(name: string) {
  return prisma.organization.create({ data: { name, slug: name.toLowerCase().replace(/\s+/g, '-') } });
}

async function makeOpenInvoice(organizationId: string, customerId: string, flatAmount: number) {
  const product = await createProduct(organizationId, { name: 'Pro product' });
  const plan = await createPlan(organizationId, {
    productId: product.id,
    name: 'Pro Monthly',
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency: 'usd',
    flatAmount,
  });
  const subscription = await createSubscription(organizationId, { customerId, planId: plan.id });
  const invoice = await generateInvoice(organizationId, { subscriptionId: subscription.id });
  return finalizeInvoice(organizationId, invoice.id);
}

// Card numbers whose last four digits drive src/lib/paymentGateway.ts's
// deterministic mock outcomes.
const CARD = {
  succeeds: '4242424242424242',
  hardDeclines: '4000000000000002',
  transientThenSucceeds: '4000000000000119',
  permanentlyDown: '4000000000000127',
};

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('addPaymentMethod', () => {
  it('tokenizes a card, storing only brand/last4/expiry', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });

    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
    });

    expect(paymentMethod.brand).toBe('VISA');
    expect(paymentMethod.last4).toBe('4242');
    expect(paymentMethod.isDefault).toBe(false);
    expect(paymentMethod).not.toHaveProperty('cardNumber');
  });

  it('rejects an expired card', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });

    await expect(
      addPaymentMethod(org.id, { customerId: customer.id, cardNumber: CARD.succeeds, expMonth: 1, expYear: 2020 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('throws a 404 for a customer belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });

    await expect(
      addPaymentMethod(orgA.id, { customerId: customerB.id, cardNumber: CARD.succeeds, expMonth: 12, expYear: 2030 }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('unsets the previous default when a new default is added', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const first = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });

    const second = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.hardDeclines,
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });

    const refreshedFirst = await getPaymentMethod(org.id, first.id);
    expect(refreshedFirst.isDefault).toBe(false);
    expect(second.isDefault).toBe(true);
  });
});

describe('listPaymentMethods', () => {
  it('only returns payment methods for the given organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerA = await createCustomer(orgA.id, { name: 'A Customer', email: 'a@example.com' });
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    await addPaymentMethod(orgA.id, { customerId: customerA.id, cardNumber: CARD.succeeds, expMonth: 12, expYear: 2030 });
    await addPaymentMethod(orgB.id, { customerId: customerB.id, cardNumber: CARD.succeeds, expMonth: 12, expYear: 2030 });

    const methods = await listPaymentMethods(orgA.id, {});

    expect(methods).toHaveLength(1);
  });

  it('filters by customerId', async () => {
    const org = await makeOrg('Acme');
    const customerA = await createCustomer(org.id, { name: 'A', email: 'a@example.com' });
    const customerB = await createCustomer(org.id, { name: 'B', email: 'b@example.com' });
    await addPaymentMethod(org.id, { customerId: customerA.id, cardNumber: CARD.succeeds, expMonth: 12, expYear: 2030 });
    await addPaymentMethod(org.id, { customerId: customerB.id, cardNumber: CARD.succeeds, expMonth: 12, expYear: 2030 });

    const methods = await listPaymentMethods(org.id, { customerId: customerA.id });

    expect(methods).toHaveLength(1);
    expect(methods[0]?.customerId).toBe(customerA.id);
  });
});

describe('chargeInvoice', () => {
  it('marks the invoice PAID and records a SUCCEEDED payment on the first attempt', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const invoice = await makeOpenInvoice(org.id, customer.id, 2900);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
    });

    const payment = await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id });

    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.attemptNumber).toBe(1);
    expect(payment.amount).toBe(2900);
    expect(payment.failureCode).toBeNull();

    const updatedInvoice = await getInvoice(org.id, invoice.id);
    expect(updatedInvoice.status).toBe('PAID');
    expect(updatedInvoice.paidAt).not.toBeNull();
  });

  it('records a FAILED payment and leaves the invoice OPEN on a hard decline, without retrying', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const invoice = await makeOpenInvoice(org.id, customer.id, 2900);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.hardDeclines,
      expMonth: 12,
      expYear: 2030,
    });

    const payment = await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id });

    expect(payment.status).toBe('FAILED');
    expect(payment.attemptNumber).toBe(1);
    expect(payment.failureCode).toBe('card_declined');

    const updatedInvoice = await getInvoice(org.id, invoice.id);
    expect(updatedInvoice.status).toBe('OPEN');
  });

  it('retries a transient processing_error and succeeds by the third attempt', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const invoice = await makeOpenInvoice(org.id, customer.id, 2900);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.transientThenSucceeds,
      expMonth: 12,
      expYear: 2030,
    });

    const payment = await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id });

    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.attemptNumber).toBe(3);
  });

  it('gives up after exhausting retries against a permanently failing processor', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const invoice = await makeOpenInvoice(org.id, customer.id, 2900);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.permanentlyDown,
      expMonth: 12,
      expYear: 2030,
    });

    const payment = await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id });

    expect(payment.status).toBe('FAILED');
    expect(payment.attemptNumber).toBe(3);
    expect(payment.failureCode).toBe('processing_error');

    const updatedInvoice = await getInvoice(org.id, invoice.id);
    expect(updatedInvoice.status).toBe('OPEN');
  });

  it('calls a custom gateway when injected, instead of the default mock', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const invoice = await makeOpenInvoice(org.id, customer.id, 2900);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
    });
    const calls: ChargeRequest[] = [];
    const stubGateway: PaymentGateway = {
      async charge(request): Promise<ChargeResult> {
        calls.push(request);
        return { status: 'declined', failureCode: 'insufficient_funds' };
      },
    };

    const payment = await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id }, stubGateway);

    expect(payment.status).toBe('FAILED');
    expect(payment.failureCode).toBe('insufficient_funds');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.amount).toBe(2900);
  });

  it('throws a 409 when the invoice is not OPEN', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const product = await createProduct(org.id, { name: 'Pro product' });
    const plan = await createPlan(org.id, {
      productId: product.id,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 2900,
    });
    const subscription = await createSubscription(org.id, { customerId: customer.id, planId: plan.id });
    const draftInvoice = await generateInvoice(org.id, { subscriptionId: subscription.id });
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
    });

    await expect(
      chargeInvoice(org.id, draftInvoice.id, { paymentMethodId: paymentMethod.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('throws a 400 when the payment method belongs to a different customer', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const otherCustomer = await createCustomer(org.id, { name: 'Other', email: 'other@example.com' });
    const invoice = await makeOpenInvoice(org.id, customer.id, 2900);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: otherCustomer.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
    });

    await expect(
      chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('throws a 404 when charging an invoice belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    const invoiceB = await makeOpenInvoice(orgB.id, customerB.id, 2900);
    const paymentMethodB = await addPaymentMethod(orgB.id, {
      customerId: customerB.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
    });

    await expect(
      chargeInvoice(orgA.id, invoiceB.id, { paymentMethodId: paymentMethodB.id }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('listPaymentsForInvoice', () => {
  it('returns payments recorded for an invoice, most recent first', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const invoice = await makeOpenInvoice(org.id, customer.id, 2900);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.hardDeclines,
      expMonth: 12,
      expYear: 2030,
    });
    await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id });

    const payments = await listPaymentsForInvoice(org.id, invoice.id);

    expect(payments).toHaveLength(1);
    expect(payments[0]?.status).toBe('FAILED');
  });

  it('throws a 404 for an invoice belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customerB = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });
    const invoiceB = await makeOpenInvoice(orgB.id, customerB.id, 2900);

    await expect(listPaymentsForInvoice(orgA.id, invoiceB.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('chargeInvoice with nothing left to collect', () => {
  // A gateway that fails loudly if it is ever reached, so these tests prove
  // the zero-value charge is never sent rather than merely tolerated.
  const unreachableGateway: PaymentGateway = {
    charge(_request: ChargeRequest): Promise<ChargeResult> {
      throw new Error('the gateway should not be called for a zero-total invoice');
    },
  };

  async function makeFullyDiscountedInvoice(organizationId: string, customerId: string) {
    const product = await createProduct(organizationId, { name: 'Pro product' });
    const plan = await createPlan(organizationId, {
      productId: product.id,
      name: 'Pro Monthly',
      pricingModel: 'FLAT',
      interval: 'MONTH',
      currency: 'usd',
      flatAmount: 2900,
    });
    const subscription = await createSubscription(organizationId, { customerId, planId: plan.id });
    await createCoupon(organizationId, {
      code: 'ONTHEHOUSE',
      type: 'PERCENT_OFF',
      percentOff: 100,
      duration: 'FOREVER',
    });
    await redeemCoupon(organizationId, subscription.id, { code: 'ONTHEHOUSE' });
    const invoice = await generateInvoice(organizationId, { subscriptionId: subscription.id });
    return finalizeInvoice(organizationId, invoice.id);
  }

  it('settles a fully discounted invoice without calling the gateway', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const invoice = await makeFullyDiscountedInvoice(org.id, customer.id);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
    });

    expect(invoice.total).toBe(0);

    const payment = await chargeInvoice(
      org.id,
      invoice.id,
      { paymentMethodId: paymentMethod.id },
      unreachableGateway,
    );

    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.amount).toBe(0);
    // No gateway attempt was made, which is what tells this apart from a
    // real charge that happened to be for nothing.
    expect(payment.attemptNumber).toBe(0);
    expect((await getInvoice(org.id, invoice.id)).status).toBe('PAID');
  });

  it('settles even with a card that would otherwise decline', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const invoice = await makeFullyDiscountedInvoice(org.id, customer.id);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.hardDeclines,
      expMonth: 12,
      expYear: 2030,
    });

    const payment = await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id });

    expect(payment.status).toBe('SUCCEEDED');
    expect((await getInvoice(org.id, invoice.id)).status).toBe('PAID');
  });

  it('opens no dunning campaign for an invoice that never failed', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const invoice = await makeFullyDiscountedInvoice(org.id, customer.id);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: customer.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
    });

    await chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id }, unreachableGateway);

    expect(await prisma.dunningCampaign.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it('still refuses a payment method belonging to a different customer', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const other = await createCustomer(org.id, { name: 'John Roe', email: 'john@example.com' });
    const invoice = await makeFullyDiscountedInvoice(org.id, customer.id);
    const paymentMethod = await addPaymentMethod(org.id, {
      customerId: other.id,
      cardNumber: CARD.succeeds,
      expMonth: 12,
      expYear: 2030,
    });

    await expect(
      chargeInvoice(org.id, invoice.id, { paymentMethodId: paymentMethod.id }, unreachableGateway),
    ).rejects.toMatchObject({ status: 400 });
  });
});
