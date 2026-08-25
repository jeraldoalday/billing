import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { createCorsMiddleware, parseAllowedOrigins } from './middleware/cors';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { couponsRouter } from './routes/coupons';
import { customersRouter } from './routes/customers';
import { dunningRouter } from './routes/dunning';
import { healthRouter } from './routes/health';
import { invoicesRouter } from './routes/invoices';
import { jobsRouter } from './routes/jobs';
import { paymentMethodsRouter } from './routes/paymentMethods';
import { plansRouter } from './routes/plans';
import { productsRouter } from './routes/products';
import { reportsRouter } from './routes/reports';
import { subscriptionsRouter } from './routes/subscriptions';
import { usageEventsRouter } from './routes/usageEvents';
import { webhookDeliveriesRouter } from './routes/webhookDeliveries';
import { webhookEndpointsRouter } from './routes/webhookEndpoints';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(createCorsMiddleware({ allowedOrigins: parseAllowedOrigins(env.CORS_ORIGINS) }));
  app.use(express.json());
  app.use(pinoHttp({ logger }));

  app.use(healthRouter);
  app.use(authRouter);
  app.use('/products', productsRouter);
  app.use('/plans', plansRouter);
  app.use('/customers', customersRouter);
  app.use('/coupons', couponsRouter);
  app.use('/subscriptions', subscriptionsRouter);
  app.use('/dunning', dunningRouter);
  app.use('/invoices', invoicesRouter);
  app.use('/jobs', jobsRouter);
  app.use('/payment-methods', paymentMethodsRouter);
  app.use('/usage-events', usageEventsRouter);
  app.use('/reports', reportsRouter);
  app.use('/webhook-endpoints', webhookEndpointsRouter);
  app.use('/webhook-deliveries', webhookDeliveriesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
