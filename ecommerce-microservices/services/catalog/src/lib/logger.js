/**
 * Structured JSON logger (pino) — identical shape to the gateway's so log
 * lines from both services can be read together and joined on requestId.
 */
import pino from 'pino';

export function createLogger({ level }) {
  return pino({
    level,
    base: { name: 'catalog' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'mongoUri', 'uri'],
      censor: '[redacted]',
    },
  });
}
