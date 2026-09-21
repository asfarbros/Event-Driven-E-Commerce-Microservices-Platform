/**
 * Structured JSON logger (pino) — identical shape to the gateway's and
 * Cart's so lines from every service can be read together and joined on
 * `requestId` (the X-Request-Id minted at the Gateway; this worker is the
 * final hop of that trace).
 *
 * Recipient addresses and message bodies never appear at info level: the
 * processor logs `to` only through maskEmail() and the redact list below is
 * the backstop for anything logged by mistake.
 */
import pino from 'pino';

export function createLogger({ level, instance }) {
  return pino({
    level,
    base: { name: 'notification', ...(instance ? { instance } : {}) },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['to', 'recipient', 'email', 'body', 'text', 'html', 'smtp.password', 'uri', 'mongoUri', 'amqpUrl', 'clerkSecretKey'],
      censor: '[redacted]',
    },
  });
}
