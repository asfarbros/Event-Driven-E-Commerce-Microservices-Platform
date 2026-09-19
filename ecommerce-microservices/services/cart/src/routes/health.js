/**
 * GET /health — liveness, always 200. Reports MongoDB (required), Redis
 * (optional) and the Catalog circuit breaker, so "up but degraded" is visible.
 *   status: ok        Mongo + Redis connected, breaker closed
 *           degraded  Mongo connected but Redis down or breaker not closed
 *           unhealthy Mongo disconnected (cart operations answer 503)
 * GET /ready — readiness: 200 iff MongoDB is connected. Redis is NOT required.
 */
import { Router } from 'express';
import { describeConnection } from '../db/mongo.js';

const startedAt = Date.now();

export function healthRouter({ version, dbName, cache, catalog }) {
  const router = Router();

  const snapshot = (req) => {
    const db = describeConnection();
    const redis = cache.describe();
    const breaker = catalog.describe();
    const status = !db.connected ? 'unhealthy' : (redis.connected && breaker.state === 'closed') ? 'ok' : 'degraded';
    return {
      status,
      service: 'cart',
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      db: { state: db.state, database: db.database ?? dbName, host: db.host, required: true },
      redis: { state: redis.state, connected: redis.connected, required: false, keyPrefix: redis.keyPrefix, ttlSeconds: redis.ttlSeconds },
      catalogBreaker: breaker,
      requestId: req.id,
    };
  };

  router.get('/health', (req, res) => res.json(snapshot(req)));
  router.get('/ready', (req, res) => {
    const body = snapshot(req);
    res.status(body.db.state === 'connected' ? 200 : 503).json(body);
  });
  return router;
}
