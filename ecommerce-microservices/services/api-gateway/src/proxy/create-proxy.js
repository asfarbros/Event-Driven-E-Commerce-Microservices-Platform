/**
 * Proxy factory: one http-proxy-middleware instance per route-table entry.
 *
 * - Bodies are streamed in both directions (nothing is buffered).
 * - `pathFilter` matches `prefix` and `prefix/…` only (segment-safe).
 * - `pathRewrite` applies the route's rule; 'strip-prefix' turns
 *   /api/catalog/products?x=1 into /products?x=1 and /api/catalog into /.
 * - Outgoing headers: X-Request-Id (correlation) always; X-User-Id only when
 *   the auth guard verified a user. Any client-supplied X-User-Id was already
 *   deleted by requestContext(); it is removed again here as defence in depth.
 * - Upstream unreachable / timed out → 503 JSON naming the service by its
 *   short name. The target URL, error codes and stacks stay in the logs.
 */
import { createProxyMiddleware } from 'http-proxy-middleware';
import { IDENTITY_HEADERS } from '../middleware/request-context.js';

const TIMEOUT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);

/** Build the path-rewrite function for a route. */
export function rewriteFor(route) {
  if (typeof route.rewrite === 'function') return route.rewrite;
  if (route.rewrite === 'none') return (path) => path;
  // 'strip-prefix'
  return (path) => {
    const stripped = path.startsWith(route.prefix) ? path.slice(route.prefix.length) : path;
    return stripped.startsWith('/') ? stripped : `/${stripped}`;
  };
}

export function matchesPrefix(prefix) {
  return (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function createServiceProxy(route, config, logger) {
  const target = config.serviceUrls[route.targetEnv];
  const rewrite = rewriteFor(route);
  const log = logger.child({ upstream: route.name });

  return createProxyMiddleware({
    target,
    changeOrigin: true,
    xfwd: true, // X-Forwarded-For / -Proto / -Host for the service's own logs
    pathFilter: matchesPrefix(route.prefix),
    pathRewrite: (path) => rewrite(path),
    // Upstream must answer within this window or the request fails with 503.
    // (Deliberately NOT setting HPM's `timeout`: that arms an inactivity timer
    // on the CLIENT socket whose default handler destroys the connection,
    // racing this one and dropping the request instead of returning JSON.)
    proxyTimeout: config.proxyTimeoutMs,
    on: {
      proxyReq: (proxyReq, req) => {
        req.proxiedService = route.name;
        for (const header of IDENTITY_HEADERS) proxyReq.removeHeader(header);
        proxyReq.setHeader('X-Request-Id', req.id);
        if (route.auth && req.userId) {
          proxyReq.setHeader('X-User-Id', req.userId);
          if (req.sessionId) proxyReq.setHeader('X-Session-Id', req.sessionId);
        }
      },
      error: (err, req, res) => {
        req.proxiedService = route.name;
        const timedOut = TIMEOUT_CODES.has(err.code);
        (req.log ?? log).error(
          { requestId: req.id, upstream: route.name, target, code: err.code, message: err.message },
          timedOut ? 'upstream timed out' : 'upstream unreachable',
        );

        // `res` is a socket for WebSocket upgrades; only HTTP responses get JSON.
        if (typeof res.status !== 'function') { res.destroy?.(); return; }
        if (res.headersSent) { res.destroy(); return; }

        res.status(503).json({
          error: 'service_unavailable',
          message: timedOut
            ? `The ${route.name} service did not respond in time. Please try again.`
            : `The ${route.name} service is currently unavailable. Please try again later.`,
          requestId: req.id,
        });
      },
    },
  });
}
