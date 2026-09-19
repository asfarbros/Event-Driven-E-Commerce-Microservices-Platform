/**
 * Authentication guard for protected routes (Clerk).
 *
 * Uses the current @clerk/express API: `clerkMiddleware()` verifies the session
 * token and decorates the request, `getAuth(req)` reads the result. Clerk's own
 * `requireAuth()` is deprecated and redirects browsers to a sign-in page, which
 * is wrong for a JSON API — so the "must be signed in" rule lives here and
 * always answers 401 JSON.
 *
 * Flow for a protected route:
 *   no `Authorization: Bearer …` header  → 401 immediately (no Clerk call)
 *   token present → clerkMiddleware verifies it
 *       verification error / signed-out → 401 (reason logged, never exposed)
 *       signed-in                       → req.userId set for the proxy to inject
 *
 * Public routes never touch this middleware.
 */
import { clerkMiddleware, getAuth } from '@clerk/express';
import { createClerkClient } from '@clerk/backend';
import { HttpError } from '../lib/http-error.js';

const BEARER = /^Bearer\s+(\S+)$/i;

export function createAuthGuard({ clerk }) {
  // Explicit client: keys come from validated config (not import-time env
  // reads) and Clerk's telemetry is off so stdout stays pure JSON logs.
  const clerkClient = createClerkClient({
    publishableKey: clerk.publishableKey,
    secretKey: clerk.secretKey,
    telemetry: { disabled: true },
  });

  const verifyToken = clerkMiddleware({
    clerkClient,
    publishableKey: clerk.publishableKey,
    secretKey: clerk.secretKey,
    // Optional: verify JWT signatures locally (no JWKS fetch) when provided.
    ...(clerk.jwtKey ? { jwtKey: clerk.jwtKey } : {}),
    // Optional azp check: when CLERK_AUTHORIZED_PARTIES is set, a token is
    // only accepted if its `azp` claim is one of those origins. Browser
    // session tokens carry azp (the frontend origin); tokens minted server-side
    // (Backend API, tests, machine clients) carry none and would be rejected —
    // so this is opt-in, not derived from the CORS list.
    ...(clerk.authorizedParties ? { authorizedParties: clerk.authorizedParties } : {}),
  });

  return function requireUser(req, res, next) {
    const unauthorized = (message) => next(new HttpError(401, 'unauthorized', message));

    if (!BEARER.test(req.headers.authorization ?? '')) {
      return unauthorized('Authentication required: send a Clerk session token as "Authorization: Bearer <token>"');
    }

    verifyToken(req, res, (err) => {
      if (err) {
        // Includes misconfiguration (bad keys, JWKS unreachable). Log loudly so
        // operators see it; the client only learns the token was not accepted.
        req.log?.error({ err: { name: err.name, message: err.message } }, 'clerk token verification failed');
        return unauthorized('Invalid or expired token');
      }
      if (res.writableEnded) return; // Clerk already answered (e.g. handshake redirect)

      let auth;
      try {
        auth = getAuth(req);
      } catch (e) {
        req.log?.error({ err: { message: e.message } }, 'clerk auth state unavailable');
        return unauthorized('Invalid or expired token');
      }

      if (!auth?.userId) {
        // Clerk attaches the verification outcome to the signed-out auth object;
        // log it (server-side only) so a rejected token is never a mystery.
        const debug = typeof auth?.debug === 'function' ? auth.debug() : undefined;
        req.log?.warn({ reason: debug?.reason ?? 'signed-out', detail: debug?.message }, 'rejected request with invalid, expired or signed-out token');
        return unauthorized('Invalid or expired token');
      }

      req.userId = auth.userId;
      req.sessionId = auth.sessionId ?? undefined;
      next();
    });
  };
}
