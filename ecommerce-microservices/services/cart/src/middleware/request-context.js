/**
 * Runs FIRST on every request.
 *
 * Correlation id: reuse the gateway's X-Request-Id when well-formed (it is
 * also forwarded to the Catalog service), otherwise mint one.
 *
 * Identity: X-User-Id is TRUSTED because the API Gateway is the only ingress
 * and it strips any client-supplied value before injecting the verified one.
 * `requireUser()` turns a missing/malformed header into 401 — there is no
 * fallback to a body field, query param or URL segment, ever. The cart key is
 * derived from req.userId and nothing else.
 */
import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http-error.js';

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

export function requireUser() {
  return (req, res, next) => {
    if (!req.userId) {
      return next(new HttpError(401, 'unauthorized', 'Missing user identity. Cart requests must come through the API Gateway with a valid session.'));
    }
    next();
  };
}
