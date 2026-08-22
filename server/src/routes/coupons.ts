import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import * as couponService from '../services/coupon.service';
import {
  createCouponSchema,
  listCouponsQuerySchema,
  listRedemptionsQuerySchema,
  updateCouponSchema,
} from '../validators/coupon';

export const couponsRouter = Router();

couponsRouter.use(requireAuth);

couponsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = createCouponSchema.parse(req.body);
    const coupon = await couponService.createCoupon(req.auth.orgId, input);
    res.status(201).json({ coupon });
  } catch (err) {
    next(err);
  }
});

couponsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listCouponsQuerySchema.parse(req.query);
    const coupons = await couponService.listCoupons(req.auth.orgId, query);
    res.json({ coupons });
  } catch (err) {
    next(err);
  }
});

// Declared before `/:id` so the literal path isn't swallowed by the
// parameterized one and read as a coupon called "redemptions".
couponsRouter.get('/redemptions', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const query = listRedemptionsQuerySchema.parse(req.query);
    const redemptions = await couponService.listRedemptions(req.auth.orgId, query);
    res.json({ redemptions });
  } catch (err) {
    next(err);
  }
});

couponsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const coupon = await couponService.getCoupon(req.auth.orgId, req.params.id);
    res.json({ coupon });
  } catch (err) {
    next(err);
  }
});

couponsRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    const input = updateCouponSchema.parse(req.body);
    const coupon = await couponService.updateCoupon(req.auth.orgId, req.params.id, input);
    res.json({ coupon });
  } catch (err) {
    next(err);
  }
});

couponsRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!req.auth) throw ApiError.unauthorized();

    await couponService.deleteCoupon(req.auth.orgId, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
