/**
 * Per-client rate limiting (keyed by IP; honours Express `trust proxy`).
 * /health is exempt so orchestrator probes are never throttled.
 */
import { rateLimit } from 'express-rate-limit';

export function rateLimiter({ rateLimit: { windowMs, max } }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
    handler: (req, res) => {
      res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests, please slow down.',
        requestId: req.id,
      });
    },
  });
}
