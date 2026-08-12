import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as productService from '../services/product.service';
import { createProductSchema, listProductsQuerySchema, updateProductSchema } from '../validators/product';

export const productsRouter = Router();

productsRouter.use(requireAuth);

productsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = createProductSchema.parse(req.body);
    const product = await productService.createProduct(req.auth.orgId, input);
    res.status(201).json({ product });
  } catch (err) {
    next(err);
  }
});

productsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listProductsQuerySchema.parse(req.query);
    const products = await productService.listProducts(req.auth.orgId, query);
    res.json({ products });
  } catch (err) {
    next(err);
  }
});

productsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const product = await productService.getProduct(req.auth.orgId, req.params.id);
    res.json({ product });
  } catch (err) {
    next(err);
  }
});

productsRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = updateProductSchema.parse(req.body);
    const product = await productService.updateProduct(req.auth.orgId, req.params.id, input);
    res.json({ product });
  } catch (err) {
    next(err);
  }
});

productsRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    await productService.deleteProduct(req.auth.orgId, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
