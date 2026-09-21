/**
 * requestContext → logging → helmet → JSON body → /health,/ready → cart routes
 * (requireUser + requireDatabase) → 404 → error handler. No CORS: browsers
 * never reach this service; the gateway owns that.
 */
import express from 'express';
import helmet from 'helmet';
import { requestContext } from './middleware/request-context.js';
import { requestLogging } from './middleware/logging.js';
import { notFound, errorHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.js';
import { createMetrics } from './lib/metrics.js';
import { cartRouter } from './routes/cart.js';
import { createCartService } from './services/cart.js';

export function createApp(config, logger, { version = '0.0.0', cache, catalog }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', 1); // one hop: the gateway

  app.use(requestContext());
  app.use(requestLogging(logger));
  const metrics = createMetrics({ service: 'cart' });
  app.use(metrics.middleware());
  app.use(helmet());
  app.use(express.json({ limit: config.bodyLimitBytes }));

  app.use(healthRouter({ version, dbName: config.mongo.dbName, cache, catalog }));
  app.get('/metrics', metrics.handler);   // Prometheus scrape (internal — the Compose network)
  app.use(cartRouter(config, createCartService({ cache, catalog, limits: config.limits })));

  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}
