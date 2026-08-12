import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { plansRouter } from './routes/plans';
import { productsRouter } from './routes/products';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json());
  app.use(pinoHttp({ logger }));

  app.use(healthRouter);
  app.use(authRouter);
  app.use('/products', productsRouter);
  app.use('/plans', plansRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
