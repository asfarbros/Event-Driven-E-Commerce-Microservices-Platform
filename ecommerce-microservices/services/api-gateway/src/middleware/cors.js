/**
 * CORS policy. Origins come from CORS_ALLOWED_ORIGINS (validated at boot: no
 * wildcard, bare origins only). The `cors` package answers preflight OPTIONS
 * requests itself with 204, which is why this runs BEFORE authentication —
 * a preflight never carries the Authorization header.
 *
 * Disallowed origins:
 *   - a preflight (OPTIONS + Access-Control-Request-Method) from an origin that
 *     is not on the list is answered 403 JSON — explicit, and it never reaches
 *     the auth guard;
 *   - a plain request from such an origin is answered WITHOUT any
 *     Access-Control-* headers, which is what makes the browser refuse to
 *     expose the response.
 * Non-browser clients (no Origin header) are unaffected — CORS is a browser
 * mechanism, not an authentication mechanism.
 */
import cors from 'cors';
import { HttpError } from '../lib/http-error.js';

export function corsPolicy({ corsOrigins }) {
  const allowed = new Set(corsOrigins);
  const isAllowed = (origin) => origin !== undefined && allowed.has(origin);

  const corsMiddleware = cors({
    origin: (origin, callback) => callback(null, isAllowed(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });

  return (req, res, next) => {
    const isPreflight = req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
    if (isPreflight && !isAllowed(req.headers.origin)) {
      return next(new HttpError(403, 'origin_not_allowed', 'This origin is not allowed to call the API'));
    }
    corsMiddleware(req, res, next);
  };
}
