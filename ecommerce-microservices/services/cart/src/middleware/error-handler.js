/**
 * Global error handler — the ONLY place that formats error responses, using
 * the same `{ error, message, requestId }` shape as the gateway (plus
 * `details` for validation errors).
 *
 * Database errors are translated here so no Mongo/Mongoose message, code or
 * connection string ever reaches a client:
 *   duplicate key (E11000)                 → 409 duplicate_sku
 *   Mongoose ValidationError / CastError   → 400 (defence in depth; zod runs first)
 *   driver not connected / network errors  → 503 database_unavailable
 *   anything else                          → 500 internal_error (logged with stack)
 */
import { HttpError } from '../lib/http-error.js';

const DEFAULT_CODES = {
  400: 'bad_request', 404: 'not_found', 409: 'conflict', 413: 'payload_too_large', 503: 'service_unavailable',
};

const DB_UNAVAILABLE_NAMES = new Set([
  'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongooseServerSelectionError',
  'MongoNotConnectedError', 'MongoTopologyClosedError', 'MongoExpiredSessionError', 'PoolClearedError',
]);

/** Convert a raw error thrown by a handler into an HttpError. */
export function translateError(err) {
  if (err instanceof HttpError) return err;

  // express.json() parse failures (body-parser sets type + status)
  if (err.type === 'entity.parse.failed') return new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  if (err.type === 'entity.too.large') return new HttpError(413, 'payload_too_large', 'Request body is too large');

  // MongoDB duplicate key — the only unique index is sku, but be generic.
  if (err.code === 11000 || err.cause?.code === 11000) {
    const dup = err.keyValue ?? err.cause?.keyValue ?? {};
    const [field, value] = Object.entries(dup)[0] ?? ['field', '?'];
    return new HttpError(409, `duplicate_${field}`, `A product with ${field} "${value}" already exists`);
  }

  if (err.name === 'ValidationError' && err.errors) {
    const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return new HttpError(400, 'validation_error', 'Validation failed', details);
  }
  if (err.name === 'CastError') return new HttpError(400, 'validation_error', `Invalid value for ${err.path}`);

  if (DB_UNAVAILABLE_NAMES.has(err.name) || DB_UNAVAILABLE_NAMES.has(err.cause?.name)) {
    return new HttpError(503, 'database_unavailable', 'The cart database is temporarily unavailable. Please try again.');
  }
  return err; // unknown → 500 path below
}

export function notFound() {
  return (req, res, next) => next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}`));
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (rawErr, req, res, next) => {
    const err = translateError(rawErr);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    // HttpError messages are written for clients (including 503 "try again");
    // only genuinely unexpected errors (500) get the generic message.
    const expose = err.expose === true && status !== 500;
    const log = req.log ?? logger;

    if (status >= 500) log.error({ err: rawErr, requestId: req.id }, status === 503 ? 'database unavailable' : 'unhandled error');

    if (res.headersSent) { res.destroy(); return; }

    res.status(status).json({
      error: err.code || DEFAULT_CODES[status] || 'internal_error',
      message: expose ? err.message : 'Internal server error',
      requestId: req.id,
      ...(expose && err.details ? { details: err.details } : {}),
    });
  };
}
