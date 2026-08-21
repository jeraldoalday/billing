import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as webhookService from '../services/webhook.service';
import {
  createWebhookEndpointSchema,
  listWebhookEndpointsQuerySchema,
  updateWebhookEndpointSchema,
} from '../validators/webhook';

export const webhookEndpointsRouter = Router();

webhookEndpointsRouter.use(requireAuth);

webhookEndpointsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = createWebhookEndpointSchema.parse(req.body);
    const endpoint = await webhookService.createWebhookEndpoint(req.auth.orgId, input);
    res.status(201).json({ endpoint });
  } catch (err) {
    next(err);
  }
});

webhookEndpointsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listWebhookEndpointsQuerySchema.parse(req.query);
    const endpoints = await webhookService.listWebhookEndpoints(req.auth.orgId, query);
    res.json({ endpoints });
  } catch (err) {
    next(err);
  }
});

webhookEndpointsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const endpoint = await webhookService.getWebhookEndpoint(req.auth.orgId, req.params.id);
    res.json({ endpoint });
  } catch (err) {
    next(err);
  }
});

webhookEndpointsRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = updateWebhookEndpointSchema.parse(req.body);
    const endpoint = await webhookService.updateWebhookEndpoint(req.auth.orgId, req.params.id, input);
    res.json({ endpoint });
  } catch (err) {
    next(err);
  }
});

// Returns the new secret in full — the only other response besides create
// that ever does (see src/services/webhook.service.ts).
webhookEndpointsRouter.post('/:id/rotate-secret', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const endpoint = await webhookService.rotateWebhookEndpointSecret(req.auth.orgId, req.params.id);
    res.json({ endpoint });
  } catch (err) {
    next(err);
  }
});

webhookEndpointsRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    await webhookService.deleteWebhookEndpoint(req.auth.orgId, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
