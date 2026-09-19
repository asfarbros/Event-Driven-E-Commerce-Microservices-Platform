/**
 * Runs FIRST on every request.
 *
 * Correlation id: the gateway forwards X-Request-Id; reuse it when well-formed
 * so one id follows the request across services. Mint a UUID if it is absent
 * (direct calls, tests) so every log line still has one.
 *
 * Identity: the gateway injects X-User-Id on authenticated routes and is the
 * ONLY thing allowed to set it (it strips client-supplied values). Catalog's
 * read routes are public, so the header is often absent — that is normal. It
 * is recorded for logging only; this service performs no authentication.
 */
import { randomUUID } from 'node:crypto';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function requestContext() {
  return (req, res, next) => {
    const inboundId = req.headers['x-request-id'];
    req.id = typeof inboundId === 'string' && REQUEST_ID_PATTERN.test(inboundId) ? inboundId : randomUUID();
    res.setHeader('X-Request-Id', req.id);

    const userId = req.headers['x-user-id'];
    req.userId = typeof userId === 'string' && USER_ID_PATTERN.test(userId) ? userId : undefined;
    next();
  };
}
