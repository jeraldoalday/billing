import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as dunningService from '../services/dunning.service';
import { listDunningCampaignsQuerySchema, runDunningSchema } from '../validators/dunning';

export const dunningRouter = Router();

dunningRouter.use(requireAuth);

dunningRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listDunningCampaignsQuerySchema.parse(req.query);
    const campaigns = await dunningService.listDunningCampaigns(req.auth.orgId, query);
    res.json({ campaigns });
  } catch (err) {
    next(err);
  }
});

// Runs every campaign whose retry is due. `asOf` lets an operator (and the
// tests) drive a schedule measured in days without waiting days; Day 10's
// worker will call the same service function on a timer.
dunningRouter.post('/run', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = runDunningSchema.parse(req.body ?? {});
    const results = await dunningService.runDueDunning(req.auth.orgId, input);
    res.json({
      campaigns: results.map((result) => result.campaign),
      outcomes: results.map((result) => result.outcome),
    });
  } catch (err) {
    next(err);
  }
});

dunningRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const campaign = await dunningService.getDunningCampaign(req.auth.orgId, req.params.id);
    res.json({ campaign });
  } catch (err) {
    next(err);
  }
});

// Retries one campaign now, ignoring its schedule — for support acting on a
// customer who says "try my card again, I've fixed it".
dunningRouter.post('/:id/retry', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const result = await dunningService.runDunningAttempt(req.auth.orgId, req.params.id, {
      force: true,
    });
    res.json({ campaign: result.campaign, outcome: result.outcome });
  } catch (err) {
    next(err);
  }
});

// Calls off a campaign without canceling the subscription, for an amount
// settled outside the system.
dunningRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const campaign = await dunningService.cancelDunning(req.auth.orgId, req.params.id);
    res.json({ campaign });
  } catch (err) {
    next(err);
  }
});
