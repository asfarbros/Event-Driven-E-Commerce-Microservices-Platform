/**
 * Assembles the Express app. Order:
 *   requestContext → logging → helmet → JSON body (size-limited)
 *   → /health, /ready → product routes (DB-guarded) → 404 → error handler
 *
 * No CORS here on purpose: browsers never call this service directly — the
 * gateway owns the CORS policy. `createApp` is pure so tests can build it
 * with their own config.
 */
import express from 'express';
import helmet from 'helmet';
import { requestContext } from './middleware/request-context.js';
import { requestLogging } from './middleware/logging.js';
import { notFound, errorHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.js';
import { createMetrics } from './lib/metrics.js';
import { productsRouter } from './routes/products.js';

export function createApp(config, logger, { version = '0.0.0' } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);
  // Behind the gateway, which sets X-Forwarded-For; trust exactly one hop so
  // the logged client ip is the real caller, not the gateway.
  app.set('trust proxy', 1);

  app.use(requestContext());
  app.use(requestLogging(logger));
  const metrics = createMetrics({ service: 'catalog' });
  app.use(metrics.middleware());
  app.use(helmet());
  app.use(express.json({ limit: config.bodyLimitBytes }));

  app.use(healthRouter({ version, dbName: config.mongo.dbName }));
  app.get('/metrics', metrics.handler);   // Prometheus scrape (internal — the Compose network)
  app.use(productsRouter(config));

  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}
