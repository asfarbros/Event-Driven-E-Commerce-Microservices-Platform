/**
 * GET /health — liveness of the gateway itself. Deliberately does NOT probe
 * downstream services: the gateway is healthy whenever it can accept requests,
 * regardless of which services happen to be up.
 */
import { Router } from 'express';

const startedAt = Date.now();

export function healthRouter({ version }) {
  const router = Router();
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'api-gateway',
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      requestId: req.id,
    });
  });
  return router;
}
