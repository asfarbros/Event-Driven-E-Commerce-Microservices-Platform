/**
 * Redis — the FAST, DISPOSABLE copy of cart contents (cache-aside).
 *
 * Key:    `${CART_REDIS_KEY_PREFIX}${userId}`   e.g. cart:user_2abc…
 * Value:  JSON { items: [{ productId, quantity }], updatedAt }   — CONTENTS ONLY.
 *         Prices are never written here; they are fetched live from Catalog
 *         on every read.
 * TTL:    CART_REDIS_TTL_SECONDS, refreshed on every write/repopulate. Expiry
 *         (or FLUSHALL, or a dead Redis) only costs one MongoDB read.
 *
 * Failure contract: NOTHING in here throws to a caller. Every operation
 * returns `{ available: false }` (get) or `false` (set/del) when Redis is
 * down, slow or errors, and the caller falls through to MongoDB. That is what
 * makes Redis an optimisation rather than a dependency:
 *   - enableOfflineQueue: false → commands fail immediately while disconnected
 *     instead of queueing until reconnect (which would hang requests);
 *   - commandTimeout → a stalled Redis cannot stall a request;
 *   - maxRetriesPerRequest: 0 → no silent retries inflating latency.
 *
 * Consistency after an outage: while Redis is down, writes still land in
 * MongoDB but cannot touch the Redis copy — and Redis persists its keys
 * (AOF), so when it comes back those copies are STALE. On every reconnect
 * after an outage the whole cart namespace is invalidated (SCAN + UNLINK),
 * which costs one MongoDB read per user on their next request and nothing
 * else. Only the TTL bounds the one residual case: a crash between the
 * MongoDB write and the Redis write.
 */
import Redis from 'ioredis';

export function createCartCache({ host, port, password, keyPrefix, ttlSeconds, commandTimeoutMs }, logger) {
  const log = logger.child({ component: 'redis', host: `${host}:${port}` });
  let lastErrorLogAt = 0;
  let stopped = false;
  let hadOutage = false; // set when the connection drops after having been ready

  const client = new Redis({
    host,
    port,
    password,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: commandTimeoutMs,
    connectionName: 'orderflow-cart',
    retryStrategy: (attempt) => (stopped ? null : Math.min(200 * attempt, 5000)),
  });

  client.on('ready', () => {
    log.info('redis connected');
    if (hadOutage) {
      hadOutage = false;
      invalidateNamespace().catch((err) => log.error({ reason: err.message }, 'namespace invalidation after outage failed'));
    }
  });
  client.on('close', () => {
    if (stopped) return;
    hadOutage = true;
    log.warn('redis connection closed — cart falls back to MongoDB until it returns');
  });
  client.on('reconnecting', (delay) => log.debug({ delayMs: delay }, 'redis reconnecting'));
  client.on('error', (err) => {
    // ioredis emits one error per failed reconnect attempt; throttle to one line / 5 s.
    const now = Date.now();
    if (now - lastErrorLogAt > 5000) {
      lastErrorLogAt = now;
      log.error({ reason: err.message }, 'redis unreachable — will keep retrying');
    }
  });

  const key = (userId) => `${keyPrefix}${userId}`;
  const isReady = () => client.status === 'ready';

  /** Drop every key in our namespace (writes made during an outage never reached them). */
  async function invalidateNamespace() {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) removed += await client.unlink(...keys);
    } while (cursor !== '0');
    log.warn({ removed, keyPrefix }, 'redis reconnected after an outage — cached carts invalidated (may be stale)');
    return removed;
  }

  return {
    /** Initial connect; never throws — the retry strategy keeps going. */
    async connect() {
      try { await client.connect(); } catch (err) { log.error({ reason: err.message }, 'redis unreachable at startup — starting without cache'); }
    },

    describe() {
      return { state: client.status, connected: isReady(), keyPrefix, ttlSeconds };
    },

    /** @returns {{ available: boolean, hit?: boolean, value?: object }} */
    async getContents(userId, reqLog = log) {
      if (!isReady()) return { available: false };
      try {
        const raw = await client.get(key(userId));
        if (raw === null) return { available: true, hit: false };
        return { available: true, hit: true, value: JSON.parse(raw) };
      } catch (err) {
        reqLog.warn({ reason: err.message }, 'redis GET failed — falling back to MongoDB');
        return { available: false };
      }
    },

    /** Write-through of contents with TTL. @returns {boolean} written */
    async setContents(userId, contents, reqLog = log) {
      if (!isReady()) return false;
      try {
        await client.set(key(userId), JSON.stringify(contents), 'EX', ttlSeconds);
        return true;
      } catch (err) {
        reqLog.warn({ reason: err.message }, 'redis SET failed — MongoDB already holds the truth, continuing');
        return false;
      }
    },

    /** @returns {boolean} removed (or nothing to remove) */
    async remove(userId, reqLog = log) {
      if (!isReady()) return false;
      try {
        await client.del(key(userId));
        return true;
      } catch (err) {
        reqLog.warn({ reason: err.message }, 'redis DEL failed — continuing');
        return false;
      }
    },

    async stop() {
      stopped = true;
      try {
        if (client.status !== 'end') await client.quit();
        log.info('redis connection closed');
      } catch { client.disconnect(); }
    },

    /** Test hooks */
    _client: client,
    _invalidateNamespace: invalidateNamespace,
  };
}
