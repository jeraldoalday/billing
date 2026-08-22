import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as couponService from '../services/coupon.service';
import * as subscriptionService from '../services/subscription.service';
import * as usageService from '../services/usage.service';
import { redeemCouponSchema } from '../validators/coupon';
import {
  cancelSubscriptionSchema,
  changeSubscriptionPlanSchema,
  createSubscriptionSchema,
  listSubscriptionsQuerySchema,
} from '../validators/subscription';

export const subscriptionsRouter = Router();

subscriptionsRouter.use(requireAuth);

subscriptionsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = createSubscriptionSchema.parse(req.body);
    const subscription = await subscriptionService.createSubscription(req.auth.orgId, input);
    res.status(201).json({ subscription });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listSubscriptionsQuerySchema.parse(req.query);
    const subscriptions = await subscriptionService.listSubscriptions(req.auth.orgId, query);
    res.json({ subscriptions });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const subscription = await subscriptionService.getSubscription(req.auth.orgId, req.params.id);
    res.json({ subscription });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = cancelSubscriptionSchema.parse(req.body);
    const subscription = await subscriptionService.cancelSubscription(
      req.auth.orgId,
      req.params.id,
      input,
    );
    res.json({ subscription });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.patch('/:id/plan', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = changeSubscriptionPlanSchema.parse(req.body);
    const result = await subscriptionService.changeSubscriptionPlan(
      req.auth.orgId,
      req.params.id,
      input,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.post('/:id/trial/end', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const subscription = await subscriptionService.endTrial(req.auth.orgId, req.params.id);
    res.json({ subscription });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.get('/:id/usage', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const summary = await usageService.getCurrentPeriodUsageSummary(req.auth.orgId, req.params.id);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// A coupon lives on the subscription it discounts rather than under
// /coupons, because that's the thing it changes the price of: attaching one
// is an edit to how this subscription bills, and there is at most one at a
// time (see src/services/coupon.service.ts).
subscriptionsRouter.post('/:id/coupon', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = redeemCouponSchema.parse(req.body);
    const redemption = await couponService.redeemCoupon(req.auth.orgId, req.params.id, input);
    res.status(201).json({ redemption });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.get('/:id/coupon', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    // Confirms the subscription is this org's before reporting on it, so a
    // missing coupon and another org's subscription can't be told apart.
    await subscriptionService.getSubscription(req.auth.orgId, req.params.id);
    const redemption = await couponService.getActiveRedemption(req.auth.orgId, req.params.id);
    res.json({ redemption });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.delete('/:id/coupon', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const redemption = await couponService.removeRedemption(req.auth.orgId, req.params.id);
    res.json({ redemption });
  } catch (err) {
    next(err);
  }
});
