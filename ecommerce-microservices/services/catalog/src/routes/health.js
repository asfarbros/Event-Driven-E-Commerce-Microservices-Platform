/**
 * GET /health — liveness. Always 200 while the process can serve requests;
 * `status` and `db.state` tell the truth about MongoDB so an operator (or a
 * demo viewer) can see "up but degraded" at a glance.
 *
 * GET /ready — readiness. 200 only when MongoDB is connected; 503 otherwise.
 * Use this for depends_on / load-balancer checks in later steps.
 */
import { Router } from 'express';
import { describeConnection } from '../db/mongo.js';

const startedAt = Date.now();

export function healthRouter({ version, dbName }) {
  const router = Router();

  const snapshot = (req) => {
    const db = describeConnection();
    return {
      status: db.connected ? 'ok' : 'degraded',
      service: 'catalog',
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      db: { state: db.state, database: db.database ?? dbName, host: db.host },
      requestId: req.id,
    };
  };

  router.get('/health', (req, res) => res.json(snapshot(req)));
  router.get('/ready', (req, res) => {
    const body = snapshot(req);
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });
  return router;
}
