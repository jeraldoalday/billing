import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as usageService from '../services/usage.service';
import { listUsageEventsQuerySchema, recordUsageEventSchema } from '../validators/usage';

export const usageEventsRouter = Router();

usageEventsRouter.use(requireAuth);

usageEventsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = recordUsageEventSchema.parse(req.body);
    const usageEvent = await usageService.recordUsageEvent(req.auth.orgId, input);
    res.status(201).json({ usageEvent });
  } catch (err) {
    next(err);
  }
});

usageEventsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listUsageEventsQuerySchema.parse(req.query);
    const usageEvents = await usageService.listUsageEvents(req.auth.orgId, query);
    res.json({ usageEvents });
  } catch (err) {
    next(err);
  }
});
