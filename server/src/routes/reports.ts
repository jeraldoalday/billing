import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as reportingService from '../services/reporting.service';
import { mrrQuerySchema, reportWindowQuerySchema } from '../validators/report';

export const reportsRouter = Router();

reportsRouter.use(requireAuth);

reportsRouter.get('/mrr', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = mrrQuerySchema.parse(req.query);
    const report = await reportingService.getMrrReport(req.auth.orgId, query);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// ARPU is derived from the same snapshot as MRR, so it is served from the
// same computation rather than a second one that could disagree with it.
reportsRouter.get('/arpu', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const { arpu, mrr, customers } = await reportingService.getMrrReport(req.auth.orgId, {
      groupBy: 'plan',
    });
    res.json({ arpu, mrr, customers });
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/churn', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const window = reportWindowQuerySchema.parse(req.query);
    const report = await reportingService.getChurnReport(req.auth.orgId, window);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/revenue', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const window = reportWindowQuerySchema.parse(req.query);
    const report = await reportingService.getRevenueReport(req.auth.orgId, window);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/summary', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const window = reportWindowQuerySchema.parse(req.query);
    const report = await reportingService.getSummaryReport(req.auth.orgId, window);
    res.json(report);
  } catch (err) {
    next(err);
  }
});
