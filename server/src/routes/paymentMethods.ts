import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as paymentService from '../services/payment.service';
import { createPaymentMethodSchema, listPaymentMethodsQuerySchema } from '../validators/paymentMethod';

export const paymentMethodsRouter = Router();

paymentMethodsRouter.use(requireAuth);

paymentMethodsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = createPaymentMethodSchema.parse(req.body);
    const paymentMethod = await paymentService.addPaymentMethod(req.auth.orgId, input);
    res.status(201).json({ paymentMethod });
  } catch (err) {
    next(err);
  }
});

paymentMethodsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listPaymentMethodsQuerySchema.parse(req.query);
    const paymentMethods = await paymentService.listPaymentMethods(req.auth.orgId, query);
    res.json({ paymentMethods });
  } catch (err) {
    next(err);
  }
});

paymentMethodsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const paymentMethod = await paymentService.getPaymentMethod(req.auth.orgId, req.params.id);
    res.json({ paymentMethod });
  } catch (err) {
    next(err);
  }
});
