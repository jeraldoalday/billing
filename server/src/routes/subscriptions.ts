import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as subscriptionService from '../services/subscription.service';
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
    const subscription = await subscriptionService.cancelSubscription(req.auth.orgId, req.params.id, input);
    res.json({ subscription });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.patch('/:id/plan', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = changeSubscriptionPlanSchema.parse(req.body);
    const result = await subscriptionService.changeSubscriptionPlan(req.auth.orgId, req.params.id, input);
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
