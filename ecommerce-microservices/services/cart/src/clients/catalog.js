/**
 * Catalog client — service-to-service call to the bulk price endpoint,
 * wrapped in an opossum circuit breaker.
 *
 *   POST ${CATALOG_SERVICE_URL}/products/prices   { productIds: [...] }
 *   → { prices: [{ productId, sku, name, priceInPaise, currency }],
 *       unavailable: [{ productId, reason: 'not_found' | 'inactive' }], asOf }
 *
 * Called DIRECTLY (not back through the API Gateway), with the inbound
 * X-Request-Id forwarded so one id traces the request through both services.
 * One call per cart read, however many line items.
 *
 * Circuit breaker (opossum) — three states, all logged as they change:
 *   CLOSED    normal; every call goes to Catalog. Failures are counted in a
 *             rolling window. Once at least `volumeThreshold` calls were made
 *             and `errorThresholdPercentage` of them failed → OPEN.
 *   OPEN      calls are rejected immediately (EOPENBREAKER) without touching
 *             the network, so a dead Catalog costs microseconds, not a
 *             timeout per request. After `resetTimeout` → HALF-OPEN.
 *   HALF-OPEN exactly one trial call is let through. Success → CLOSED;
 *             failure → OPEN again for another `resetTimeout`.
 *
 * What counts as a failure: network errors, timeouts, and 5xx from Catalog.
 * A 4xx (our request was malformed) is NOT a Catalog outage, so `errorFilter`
 * keeps it from tripping the breaker — the caller still gets the error.
 */
import CircuitBreaker from 'opossum';

export class CatalogUnavailableError extends Error {
  constructor(reason, cause) {
    super(`Catalog service unavailable (${reason})`);
    this.name = 'CatalogUnavailableError';
    this.reason = reason; // 'breaker_open' | 'timeout' | 'network' | 'upstream_error'
    if (cause) this.cause = cause;
  }
}

class CatalogHttpError extends Error {
  constructor(status, body) {
    super(`Catalog responded ${status}`);
    this.name = 'CatalogHttpError';
    this.status = status;
    this.body = body;
  }
}

export function createCatalogClient({ baseUrl, timeoutMs, breaker: opts }, logger) {
  const log = logger.child({ component: 'catalog-client', target: baseUrl });

  async function fetchPrices({ productIds, requestId }) {
    const res = await fetch(`${baseUrl}/products/prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Request-Id': requestId },
      body: JSON.stringify({ productIds }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new CatalogHttpError(res.status, body);
    return body;
  }

  const breaker = new CircuitBreaker(fetchPrices, {
    name: 'catalog-prices',
    timeout: timeoutMs + 100,                     // safety net behind the fetch abort
    errorThresholdPercentage: opts.errorThresholdPercentage,
    volumeThreshold: opts.volumeThreshold,
    resetTimeout: opts.resetTimeoutMs,
    rollingCountTimeout: opts.rollingWindowMs,
    rollingCountBuckets: 10,
    errorFilter: (err) => err instanceof CatalogHttpError && err.status < 500, // 4xx: not an outage
  });

  const state = () => (breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed');
  const cfg = { errorThresholdPercentage: opts.errorThresholdPercentage, volumeThreshold: opts.volumeThreshold, resetTimeoutMs: opts.resetTimeoutMs, rollingWindowMs: opts.rollingWindowMs, timeoutMs };

  breaker.on('open', () => log.warn({ transition: 'closed → OPEN', stats: summary(), reopenTrialInMs: opts.resetTimeoutMs }, 'circuit breaker OPENED — catalog calls will fail fast'));
  breaker.on('halfOpen', () => log.warn({ transition: 'open → HALF-OPEN' }, 'circuit breaker HALF-OPEN — letting one trial call through'));
  breaker.on('close', () => log.info({ transition: 'half-open → CLOSED' }, 'circuit breaker CLOSED — catalog is healthy again'));
  breaker.on('reject', () => log.debug('catalog call rejected: breaker is open'));
  breaker.on('timeout', () => log.warn({ timeoutMs }, 'catalog call timed out'));

  function summary() {
    const s = breaker.stats;
    return { fires: s.fires, successes: s.successes, failures: s.failures, timeouts: s.timeouts, rejects: s.rejects };
  }

  return {
    /**
     * @returns {Promise<{prices: Array, unavailable: Array, asOf: string}>}
     * @throws {CatalogUnavailableError} when the breaker is open or Catalog cannot answer
     * @throws {CatalogHttpError} when Catalog rejects the request (4xx) — a bug on our side
     */
    async getPrices(productIds, { requestId, log: reqLog = log } = {}) {
      const startedAt = process.hrtime.bigint();
      try {
        const result = await breaker.fire({ productIds, requestId });
        reqLog.debug({ ids: productIds.length, breaker: state(), ms: elapsed(startedAt) }, 'catalog prices fetched');
        return result;
      } catch (err) {
        const ms = elapsed(startedAt);
        if (err.code === 'EOPENBREAKER') {
          reqLog.warn({ breaker: 'open', ms }, 'catalog call rejected by open breaker (fast fail)');
          throw new CatalogUnavailableError('breaker_open', err);
        }
        if (err instanceof CatalogHttpError && err.status < 500) throw err;
        const reason = err.code === 'ETIMEDOUT' || err.name === 'TimeoutError' ? 'timeout'
          : err instanceof CatalogHttpError ? 'upstream_error' : 'network';
        reqLog.warn({ breaker: state(), reason, detail: err.cause?.code ?? err.message, ms }, 'catalog call failed');
        throw new CatalogUnavailableError(reason, err);
      }
    },

    describe() {
      return { state: state(), stats: summary(), config: cfg };
    },

    stop() {
      breaker.shutdown();
    },

    /** Test hook */
    _breaker: breaker,
  };
}

function elapsed(startedAt) {
  return Number((process.hrtime.bigint() - startedAt) / 1000n) / 1000;
}
