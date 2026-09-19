/**
 * Runs FIRST on every request.
 *
 * 1. Correlation id: reuse a well-formed inbound X-Request-Id, otherwise mint a
 *    UUID. It is exposed on the response, attached to every log line and
 *    forwarded to downstream services, so one id traces a request end-to-end.
 * 2. Spoofing guard: identity headers are stripped from the inbound request.
 *    Downstream services trust X-User-Id blindly, so the gateway must be the
 *    ONLY thing that can set it (see proxy/create-proxy.js for the injection).
 */
import { randomUUID } from 'node:crypto';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Headers a client must never be able to smuggle through to a service. */
export const IDENTITY_HEADERS = ['x-user-id', 'x-session-id'];

export function requestContext() {
  return (req, res, next) => {
    const inbound = req.headers['x-request-id'];
    req.id = typeof inbound === 'string' && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
    res.setHeader('X-Request-Id', req.id);

    for (const header of IDENTITY_HEADERS) {
      delete req.headers[header];
    }
    next();
  };
}
