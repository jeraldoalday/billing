import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import * as authService from '../services/auth.service';
import { loginSchema, signupSchema } from '../validators/auth';

export const authRouter = Router();

authRouter.post('/auth/signup', async (req, res, next) => {
  try {
    const input = signupSchema.parse(req.body);
    const result = await authService.signup(input);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/auth/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.get('/auth/me', requireAuth, async (req, res, next) => {
  try {
    if (!req.auth) {
      throw ApiError.unauthorized();
    }

    const user = await prisma.user.findUnique({
      where: { id: req.auth.sub },
      include: { organization: true },
    });

    if (!user) {
      throw ApiError.unauthorized('Account no longer exists');
    }

    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      organization: { id: user.organization.id, name: user.organization.name, slug: user.organization.slug },
    });
  } catch (err) {
    next(err);
  }
});
