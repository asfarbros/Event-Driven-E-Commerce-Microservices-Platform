/**
 * Recipient resolution. The command carries the customer's `userId` (the
 * Clerk id the Gateway injected as X-User-Id), not an address — users are
 * owned by Clerk, so this is the one place the worker asks Clerk for the
 * primary e-mail (Backend API GET /v1/users/{id}, same secret the Gateway
 * uses). Results are cached in memory for NOTIFICATION_RECIPIENT_CACHE_TTL_S
 * so retries of the same message do not re-ask.
 *
 *   clerk   real lookup; 404 → UnprocessableError (user gone: will never
 *           succeed → DLQ), network / 5xx / 429 → transient (→ retry).
 *   static  every message goes to NOTIFICATION_STATIC_RECIPIENT — for
 *           offline demos and for the Mailpit inbox.
 */
import { UnprocessableError } from './lib/errors.js';

export function createRecipientResolver(cfg, logger) {
  const log = logger.child({ component: 'recipients', source: cfg.source });

  if (cfg.source === 'static') {
    return {
      source: 'static',
      async resolve(userId) { return { to: cfg.staticRecipient, toName: `Customer ${userId}` }; },
      describe() { return { source: 'static' }; },
    };
  }

  const cache = new Map();   // userId → { value, expiresAt }
  const pending = new Map(); // userId → in-flight lookup promise (single-flight: N concurrent deliveries for one user = 1 request)
  const ttlMs = cfg.cacheTtlSeconds * 1000;

  async function lookup(userId) {
    const url = `${cfg.clerkApiUrl}/v1/users/${encodeURIComponent(userId)}`;
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.clerkSecretKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(cfg.clerkTimeoutMs),
      });
    } catch (err) {
      throw new Error(`clerk user lookup failed: ${err.cause?.code || err.name}: ${err.message}`);
    }
    if (res.status === 404) throw new UnprocessableError('user_not_found', `user ${userId} does not exist in Clerk`);
    if (res.status === 401 || res.status === 403) throw new Error(`clerk rejected the secret key (HTTP ${res.status}) — check CLERK_SECRET_KEY`);
    if (!res.ok) throw new Error(`clerk user lookup returned HTTP ${res.status}`);
    const user = await res.json();
    const primary = (user.email_addresses || []).find((e) => e.id === user.primary_email_address_id) || user.email_addresses?.[0];
    if (!primary?.email_address) throw new UnprocessableError('user_has_no_email', `user ${userId} has no e-mail address`);
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined;
    return { to: primary.email_address, toName: name };
  }

  return {
    source: 'clerk',
    async resolve(userId) {
      const hit = cache.get(userId);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      if (pending.has(userId)) return pending.get(userId);
      const flight = lookup(userId).then((value) => {
        if (ttlMs > 0) cache.set(userId, { value, expiresAt: Date.now() + ttlMs });
        log.debug({ userId, cached: ttlMs > 0 }, 'recipient resolved');
        return value;
      }).finally(() => pending.delete(userId));
      pending.set(userId, flight);
      return flight;
    },
    describe() { return { source: 'clerk', apiUrl: cfg.clerkApiUrl, cacheTtlSeconds: cfg.cacheTtlSeconds, cached: cache.size, inFlight: pending.size }; },
  };
}
