/**
 * Assembles the Express app. Order matters:
 *
 *   requestContext → logging → helmet → CORS (answers preflights) → rate limit
 *   → body limit → /health → per-route [auth guard] + proxy → 404 → error handler
 *
 * `createApp` is pure: it takes a validated config and a logger and returns an
 * app, so tests can build instances with their own settings.
 */
import express from 'express';
import helmet from 'helmet';
import { requestContext } from './middleware/request-context.js';
import { requestLogging } from './middleware/logging.js';
import { corsPolicy } from './middleware/cors.js';
import { rateLimiter } from './middleware/rate-limit.js';
import { bodyLimit } from './middleware/body-limit.js';
import { createAuthGuard } from './middleware/auth.js';
import { notFound, errorHandler } from './middleware/error-handler.js';
import { createServiceProxy } from './proxy/create-proxy.js';
import { healthRouter } from './routes/health.js';

export function createApp(config, logger, { version = '0.0.0' } = {}) {
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.set('etag', false); // responses are pass-through; let services decide caching

  app.use(requestContext());
  app.use(requestLogging(logger));
  app.use(helmet({
    // The gateway serves an API consumed cross-origin (and later maybe images
    // via the catalog); the default same-origin CORP would block those embeds.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(corsPolicy(config));
  app.use(rateLimiter(config));
  app.use(bodyLimit(config));

  app.use(healthRouter({ version }));

  // Route table → [guard] + proxy. The guard is mounted on the prefix (Express
  // matches whole path segments); the proxy is mounted at the root and filters
  // on the same prefix, so it sees the full URL and applies the explicit rewrite.
  const requireUser = createAuthGuard(config);
  for (const route of config.routes) {
    if (route.auth) app.use(route.prefix, requireUser);
    app.use(createServiceProxy(route, config, logger));
    logger.info(
      { prefix: route.prefix, service: route.name, auth: route.auth, rewrite: typeof route.rewrite === 'function' ? 'custom' : route.rewrite },
      'route registered',
    );
  }

  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}
