import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as planService from '../services/plan.service';
import { createPlanSchema, listPlansQuerySchema, updatePlanSchema } from '../validators/plan';

export const plansRouter = Router();

plansRouter.use(requireAuth);

plansRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = createPlanSchema.parse(req.body);
    const plan = await planService.createPlan(req.auth.orgId, input);
    res.status(201).json({ plan });
  } catch (err) {
    next(err);
  }
});

plansRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listPlansQuerySchema.parse(req.query);
    const plans = await planService.listPlans(req.auth.orgId, query);
    res.json({ plans });
  } catch (err) {
    next(err);
  }
});

plansRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const plan = await planService.getPlan(req.auth.orgId, req.params.id);
    res.json({ plan });
  } catch (err) {
    next(err);
  }
});

plansRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = updatePlanSchema.parse(req.body);
    const plan = await planService.updatePlan(req.auth.orgId, req.params.id, input);
    res.json({ plan });
  } catch (err) {
    next(err);
  }
});

plansRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    await planService.deletePlan(req.auth.orgId, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
