/**
 * Global error handler — the ONLY place that formats error responses.
 * Every error becomes `{ error, message, requestId }`. Unexpected errors are
 * logged with their stack but the client only ever sees a generic message.
 */
import { HttpError } from '../lib/http-error.js';

const DEFAULT_CODES = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  413: 'payload_too_large',
  429: 'rate_limited',
  503: 'service_unavailable',
};

/** Anything that reached the end of the chain has no route. */
export function notFound() {
  return (req, res, next) => {
    next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}`));
  };
}

export function errorHandler(logger) {
  // Express identifies error handlers by arity — keep all four parameters.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    const expose = err.expose === true && status < 500;
    const log = req.log ?? logger;

    if (status >= 500) log.error({ err, requestId: req.id }, 'unhandled error');

    // If the downstream response already started streaming we cannot replace
    // it with JSON; the only honest option is to cut the connection.
    if (res.headersSent) {
      res.destroy();
      return;
    }

    res.status(status).json({
      error: err.code || DEFAULT_CODES[status] || 'internal_error',
      message: expose ? err.message : 'Internal server error',
      requestId: req.id,
    });
  };
}
