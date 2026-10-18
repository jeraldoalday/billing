import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import {
  consumeRedemptionPeriod,
  createCoupon,
  deleteCoupon,
  getActiveRedemption,
  getCoupon,
  getCouponByCode,
  listCoupons,
  listRedemptions,
  redeemCoupon,
  removeRedemption,
  updateCoupon,
} from './coupon.service';
import { createCustomer } from './customer.service';
import { createPlan } from './plan.service';
import { createProduct } from './product.service';
import { cancelSubscription, createSubscription } from './subscription.service';

async function resetDb() {
  await prisma.couponRedemption.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.product.deleteMany();
  await prisma.organization.deleteMany();
}

async function makeOrg(name: string) {
  return prisma.organization.create({
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Math.random().toString(36).slice(2)}` },
  });
}

async function makeSubscription(organizationId: string, currency = 'usd') {
  const email = `${Math.random().toString(36).slice(2)}@example.com`;
  const customer = await createCustomer(organizationId, { name: 'Jane Doe', email });
  const product = await createProduct(organizationId, { name: 'Pro product' });
  const plan = await createPlan(organizationId, {
    productId: product.id,
    name: 'Pro',
    pricingModel: 'FLAT',
    interval: 'MONTH',
    currency,
    flatAmount: 5000,
  });
  const subscription = await createSubscription(organizationId, {
    customerId: customer.id,
    planId: plan.id,
  });
  return { customer, plan, subscription };
}

const PERCENT_COUPON = {
  code: 'SAVE20',
  type: 'PERCENT_OFF' as const,
  percentOff: 20,
  duration: 'FOREVER' as const,
};

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('createCoupon', () => {
  it('creates a percent-off coupon with only its own fields set', async () => {
    const org = await makeOrg('Acme');

    const coupon = await createCoupon(org.id, PERCENT_COUPON);

    expect(coupon.percentOff).toBe(20);
    expect(coupon.amountOff).toBeNull();
    expect(coupon.currency).toBeNull();
    expect(coupon.timesRedeemed).toBe(0);
    expect(coupon.active).toBe(true);
  });

  it('creates an amount-off coupon with its currency', async () => {
    const org = await makeOrg('Acme');

    const coupon = await createCoupon(org.id, {
      code: 'TENOFF',
      type: 'AMOUNT_OFF',
      amountOff: 1000,
      currency: 'usd',
      duration: 'ONCE',
    });

    expect(coupon.amountOff).toBe(1000);
    expect(coupon.currency).toBe('usd');
    expect(coupon.percentOff).toBeNull();
  });

  it('keeps durationInMonths only for a repeating coupon', async () => {
    const org = await makeOrg('Acme');

    const repeating = await createCoupon(org.id, {
      code: 'THREEMONTHS',
      type: 'PERCENT_OFF',
      percentOff: 50,
      duration: 'REPEATING',
      durationInMonths: 3,
    });

    expect(repeating.durationInMonths).toBe(3);
  });

  it('rejects a duplicate code within the same organization', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);

    await expect(createCoupon(org.id, PERCENT_COUPON)).rejects.toMatchObject({ status: 409 });
  });

  it('lets two organizations use the same code', async () => {
    const orgA = await makeOrg('Acme');
    const orgB = await makeOrg('Globex');
    await createCoupon(orgA.id, PERCENT_COUPON);

    const couponB = await createCoupon(orgB.id, PERCENT_COUPON);

    expect(couponB.code).toBe('SAVE20');
  });
});

describe('listCoupons and getCoupon', () => {
  it('lists only the requesting organization coupons', async () => {
    const orgA = await makeOrg('Acme');
    const orgB = await makeOrg('Globex');
    await createCoupon(orgA.id, PERCENT_COUPON);
    await createCoupon(orgB.id, { ...PERCENT_COUPON, code: 'OTHER' });

    const coupons = await listCoupons(orgA.id, {});

    expect(coupons).toHaveLength(1);
    expect(coupons[0]?.code).toBe('SAVE20');
  });

  it('filters by active state and duration', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);
    await createCoupon(org.id, {
      code: 'ONETIME',
      type: 'PERCENT_OFF',
      percentOff: 10,
      duration: 'ONCE',
      active: false,
    });

    expect(await listCoupons(org.id, { active: false })).toHaveLength(1);
    expect(await listCoupons(org.id, { duration: 'ONCE' })).toHaveLength(1);
  });

  it('404s for a coupon belonging to another organization', async () => {
    const orgA = await makeOrg('Acme');
    const orgB = await makeOrg('Globex');
    const coupon = await createCoupon(orgB.id, PERCENT_COUPON);

    await expect(getCoupon(orgA.id, coupon.id)).rejects.toMatchObject({ status: 404 });
  });

  it('looks a coupon up by code', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);

    const coupon = await getCouponByCode(org.id, 'SAVE20');

    expect(coupon.percentOff).toBe(20);
  });
});

describe('updateCoupon and deleteCoupon', () => {
  it('deactivates a coupon without touching its discount', async () => {
    const org = await makeOrg('Acme');
    const coupon = await createCoupon(org.id, PERCENT_COUPON);

    const updated = await updateCoupon(org.id, coupon.id, { active: false });

    expect(updated.active).toBe(false);
    expect(updated.percentOff).toBe(20);
  });

  it('clears a redemption limit when it is set to null', async () => {
    const org = await makeOrg('Acme');
    const coupon = await createCoupon(org.id, { ...PERCENT_COUPON, maxRedemptions: 5 });

    const updated = await updateCoupon(org.id, coupon.id, { maxRedemptions: null });

    expect(updated.maxRedemptions).toBeNull();
  });

  it('deletes a coupon nobody has redeemed', async () => {
    const org = await makeOrg('Acme');
    const coupon = await createCoupon(org.id, PERCENT_COUPON);

    await deleteCoupon(org.id, coupon.id);

    await expect(getCoupon(org.id, coupon.id)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to delete a coupon that has been redeemed', async () => {
    const org = await makeOrg('Acme');
    const coupon = await createCoupon(org.id, PERCENT_COUPON);
    const { subscription } = await makeSubscription(org.id);
    await redeemCoupon(org.id, subscription.id, { code: coupon.code });

    await expect(deleteCoupon(org.id, coupon.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('redeemCoupon', () => {
  it('attaches a coupon to a subscription and counts the redemption', async () => {
    const org = await makeOrg('Acme');
    const coupon = await createCoupon(org.id, PERCENT_COUPON);
    const { subscription } = await makeSubscription(org.id);

    const redemption = await redeemCoupon(org.id, subscription.id, { code: 'SAVE20' });

    expect(redemption.status).toBe('ACTIVE');
    expect(redemption.periodsApplied).toBe(0);
    expect(redemption.coupon.code).toBe('SAVE20');
    expect((await getCoupon(org.id, coupon.id)).timesRedeemed).toBe(1);
  });

  it('refuses a second coupon while one is already active', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);
    await createCoupon(org.id, { ...PERCENT_COUPON, code: 'SAVE30', percentOff: 30 });
    const { subscription } = await makeSubscription(org.id);
    await redeemCoupon(org.id, subscription.id, { code: 'SAVE20' });

    await expect(redeemCoupon(org.id, subscription.id, { code: 'SAVE30' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('lets only one of two concurrent redemptions attach to the same subscription', async () => {
    // Both calls find no active redemption before either writes, the way
    // two overlapping POST /subscriptions/:id/coupon requests on the same
    // subscription would. coupon_redemptions_subscription_active_key is
    // what actually stops the second one; without the fallback onto the
    // same 409 the sequential check throws, the loser would surface a raw
    // database error instead.
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);
    await createCoupon(org.id, { ...PERCENT_COUPON, code: 'SAVE30', percentOff: 30 });
    const { subscription } = await makeSubscription(org.id);

    const results = await Promise.allSettled([
      redeemCoupon(org.id, subscription.id, { code: 'SAVE20' }),
      redeemCoupon(org.id, subscription.id, { code: 'SAVE30' }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    const redemptions = await prisma.couponRedemption.findMany({
      where: { subscriptionId: subscription.id, status: 'ACTIVE' },
    });
    expect(redemptions).toHaveLength(1);
    const winner = redemptions[0]!;

    // The loser's coupon.update (incrementing timesRedeemed) rolled back
    // with the rest of its transaction, so only the winner's coupon was
    // counted as redeemed, whichever of the two it was.
    expect((await getCoupon(org.id, winner.couponId)).timesRedeemed).toBe(1);
  });

  it('allows a new coupon once the previous one has been removed', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);
    await createCoupon(org.id, { ...PERCENT_COUPON, code: 'SAVE30', percentOff: 30 });
    const { subscription } = await makeSubscription(org.id);
    await redeemCoupon(org.id, subscription.id, { code: 'SAVE20' });
    await removeRedemption(org.id, subscription.id);

    const redemption = await redeemCoupon(org.id, subscription.id, { code: 'SAVE30' });

    expect(redemption.coupon.code).toBe('SAVE30');
  });

  it('refuses an inactive coupon', async () => {
    const org = await makeOrg('Acme');
    const coupon = await createCoupon(org.id, PERCENT_COUPON);
    await updateCoupon(org.id, coupon.id, { active: false });
    const { subscription } = await makeSubscription(org.id);

    await expect(redeemCoupon(org.id, subscription.id, { code: 'SAVE20' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses an expired coupon', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, { ...PERCENT_COUPON, redeemBy: new Date('2020-01-01T00:00:00Z') });
    const { subscription } = await makeSubscription(org.id);

    await expect(redeemCoupon(org.id, subscription.id, { code: 'SAVE20' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a coupon that has reached its redemption limit', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, { ...PERCENT_COUPON, maxRedemptions: 1 });
    const first = await makeSubscription(org.id);
    const second = await makeSubscription(org.id);
    await redeemCoupon(org.id, first.subscription.id, { code: 'SAVE20' });

    await expect(redeemCoupon(org.id, second.subscription.id, { code: 'SAVE20' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('still counts a removed redemption against the redemption limit', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, { ...PERCENT_COUPON, maxRedemptions: 1 });
    const first = await makeSubscription(org.id);
    const second = await makeSubscription(org.id);
    await redeemCoupon(org.id, first.subscription.id, { code: 'SAVE20' });
    await removeRedemption(org.id, first.subscription.id);

    await expect(redeemCoupon(org.id, second.subscription.id, { code: 'SAVE20' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses an amount-off coupon in a different currency to the plan', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, {
      code: 'EUROFF',
      type: 'AMOUNT_OFF',
      amountOff: 1000,
      currency: 'eur',
      duration: 'ONCE',
    });
    const { subscription } = await makeSubscription(org.id, 'usd');

    await expect(redeemCoupon(org.id, subscription.id, { code: 'EUROFF' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses a coupon on a canceled subscription', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);
    const { subscription } = await makeSubscription(org.id);
    await cancelSubscription(org.id, subscription.id, { atPeriodEnd: false });

    await expect(redeemCoupon(org.id, subscription.id, { code: 'SAVE20' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('404s when the subscription belongs to another organization', async () => {
    const orgA = await makeOrg('Acme');
    const orgB = await makeOrg('Globex');
    await createCoupon(orgA.id, PERCENT_COUPON);
    const { subscription } = await makeSubscription(orgB.id);

    await expect(redeemCoupon(orgA.id, subscription.id, { code: 'SAVE20' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('404s when the code belongs to another organization', async () => {
    const orgA = await makeOrg('Acme');
    const orgB = await makeOrg('Globex');
    await createCoupon(orgB.id, PERCENT_COUPON);
    const { subscription } = await makeSubscription(orgA.id);

    await expect(redeemCoupon(orgA.id, subscription.id, { code: 'SAVE20' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('getActiveRedemption and listRedemptions', () => {
  it('returns null when a subscription has no coupon', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeSubscription(org.id);

    expect(await getActiveRedemption(org.id, subscription.id)).toBeNull();
  });

  it('does not leak another organization redemption', async () => {
    const orgA = await makeOrg('Acme');
    const orgB = await makeOrg('Globex');
    await createCoupon(orgB.id, PERCENT_COUPON);
    const { subscription } = await makeSubscription(orgB.id);
    await redeemCoupon(orgB.id, subscription.id, { code: 'SAVE20' });

    expect(await getActiveRedemption(orgA.id, subscription.id)).toBeNull();
  });

  it('filters redemptions by status', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);
    const { subscription } = await makeSubscription(org.id);
    await redeemCoupon(org.id, subscription.id, { code: 'SAVE20' });
    await removeRedemption(org.id, subscription.id);

    expect(await listRedemptions(org.id, { status: 'REMOVED' })).toHaveLength(1);
    expect(await listRedemptions(org.id, { status: 'ACTIVE' })).toHaveLength(0);
  });
});

describe('removeRedemption', () => {
  it('marks the redemption removed and stamps when it ended', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);
    const { subscription } = await makeSubscription(org.id);
    await redeemCoupon(org.id, subscription.id, { code: 'SAVE20' });

    const removed = await removeRedemption(org.id, subscription.id);

    expect(removed.status).toBe('REMOVED');
    expect(removed.endedAt).not.toBeNull();
  });

  it('404s when there is nothing to remove', async () => {
    const org = await makeOrg('Acme');
    const { subscription } = await makeSubscription(org.id);

    await expect(removeRedemption(org.id, subscription.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('consumeRedemptionPeriod', () => {
  it('keeps a forever redemption active as it is used', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, PERCENT_COUPON);
    const { subscription } = await makeSubscription(org.id);
    const redemption = await redeemCoupon(org.id, subscription.id, { code: 'SAVE20' });

    await prisma.$transaction((tx) => consumeRedemptionPeriod(tx, redemption));

    const after = await getActiveRedemption(org.id, subscription.id);
    expect(after?.periodsApplied).toBe(1);
    expect(after?.status).toBe('ACTIVE');
  });

  it('completes a once redemption the first time it is used', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, { ...PERCENT_COUPON, code: 'FIRSTMONTH', duration: 'ONCE' });
    const { subscription } = await makeSubscription(org.id);
    const redemption = await redeemCoupon(org.id, subscription.id, { code: 'FIRSTMONTH' });

    await prisma.$transaction((tx) => consumeRedemptionPeriod(tx, redemption));

    expect(await getActiveRedemption(org.id, subscription.id)).toBeNull();
    const [completed] = await listRedemptions(org.id, { status: 'COMPLETED' });
    expect(completed?.periodsApplied).toBe(1);
    expect(completed?.endedAt).not.toBeNull();
  });

  it('completes a repeating redemption only once its months are spent', async () => {
    const org = await makeOrg('Acme');
    await createCoupon(org.id, {
      code: 'TWOMONTHS',
      type: 'PERCENT_OFF',
      percentOff: 50,
      duration: 'REPEATING',
      durationInMonths: 2,
    });
    const { subscription } = await makeSubscription(org.id);
    const redemption = await redeemCoupon(org.id, subscription.id, { code: 'TWOMONTHS' });

    await prisma.$transaction((tx) => consumeRedemptionPeriod(tx, redemption));
    const afterFirst = await getActiveRedemption(org.id, subscription.id);
    expect(afterFirst?.status).toBe('ACTIVE');

    await prisma.$transaction((tx) => consumeRedemptionPeriod(tx, afterFirst!));

    expect(await getActiveRedemption(org.id, subscription.id)).toBeNull();
  });
});
