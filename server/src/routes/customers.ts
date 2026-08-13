import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as customerService from '../services/customer.service';
import { createCustomerSchema, listCustomersQuerySchema, updateCustomerSchema } from '../validators/customer';

export const customersRouter = Router();

customersRouter.use(requireAuth);

customersRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = createCustomerSchema.parse(req.body);
    const customer = await customerService.createCustomer(req.auth.orgId, input);
    res.status(201).json({ customer });
  } catch (err) {
    next(err);
  }
});

customersRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listCustomersQuerySchema.parse(req.query);
    const customers = await customerService.listCustomers(req.auth.orgId, query);
    res.json({ customers });
  } catch (err) {
    next(err);
  }
});

customersRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const customer = await customerService.getCustomer(req.auth.orgId, req.params.id);
    res.json({ customer });
  } catch (err) {
    next(err);
  }
});

customersRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = updateCustomerSchema.parse(req.body);
    const customer = await customerService.updateCustomer(req.auth.orgId, req.params.id, input);
    res.json({ customer });
  } catch (err) {
    next(err);
  }
});

customersRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    await customerService.deleteCustomer(req.auth.orgId, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
