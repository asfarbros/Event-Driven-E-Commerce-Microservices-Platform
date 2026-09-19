/**
 * Structured JSON logger (pino). One line per event, always JSON — pipe
 * through `npx pino-pretty` when reading by eye.
 */
import pino from 'pino';

export function createLogger({ level }) {
  return pino({
    level,
    base: { name: 'api-gateway' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Never log secrets even if someone logs a whole request by mistake.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie'],
      censor: '[redacted]',
    },
  });
}
