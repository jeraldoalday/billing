import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as webhookService from '../services/webhook.service';
import { listWebhookDeliveriesQuerySchema } from '../validators/webhook';

export const webhookDeliveriesRouter = Router();

webhookDeliveriesRouter.use(requireAuth);

webhookDeliveriesRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listWebhookDeliveriesQuerySchema.parse(req.query);
    const deliveries = await webhookService.listWebhookDeliveries(req.auth.orgId, query);
    res.json({ deliveries });
  } catch (err) {
    next(err);
  }
});

webhookDeliveriesRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const delivery = await webhookService.getWebhookDelivery(req.auth.orgId, req.params.id);
    res.json({ delivery });
  } catch (err) {
    next(err);
  }
});

// Queues and immediately attempts a copy of an existing delivery, for when a
// receiver was down long enough to burn the retry budget or lost the event
// on its own side.
webhookDeliveriesRouter.post('/:id/redeliver', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const delivery = await webhookService.redeliverWebhookDelivery(req.auth.orgId, req.params.id);
    res.status(201).json({ delivery });
  } catch (err) {
    next(err);
  }
});

// Runs the retry sweep for this organization's due deliveries. Day 10's
// background worker will call the same service function on a schedule; this
// endpoint is what makes it operable (and testable) before then.
webhookDeliveriesRouter.post('/retry-due', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const deliveries = await webhookService.retryDueWebhookDeliveries(req.auth.orgId);
    res.json({ deliveries });
  } catch (err) {
    next(err);
  }
});
