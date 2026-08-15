import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as invoiceService from '../services/invoice.service';
import { generateInvoiceSchema, listInvoicesQuerySchema } from '../validators/invoice';

export const invoicesRouter = Router();

invoicesRouter.use(requireAuth);

invoicesRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = generateInvoiceSchema.parse(req.body);
    const invoice = await invoiceService.generateInvoice(req.auth.orgId, input);
    res.status(201).json({ invoice });
  } catch (err) {
    next(err);
  }
});

invoicesRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listInvoicesQuerySchema.parse(req.query);
    const invoices = await invoiceService.listInvoices(req.auth.orgId, query);
    res.json({ invoices });
  } catch (err) {
    next(err);
  }
});

invoicesRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const invoice = await invoiceService.getInvoice(req.auth.orgId, req.params.id);
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

invoicesRouter.post('/:id/finalize', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const invoice = await invoiceService.finalizeInvoice(req.auth.orgId, req.params.id);
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

invoicesRouter.post('/:id/pay', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const invoice = await invoiceService.markInvoicePaid(req.auth.orgId, req.params.id);
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

invoicesRouter.post('/:id/void', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const invoice = await invoiceService.voidInvoice(req.auth.orgId, req.params.id);
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});
