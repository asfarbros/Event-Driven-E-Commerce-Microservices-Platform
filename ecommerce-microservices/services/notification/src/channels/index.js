/**
 * Delivery channel abstraction. The consumer never knows which channel is
 * in use; it calls `channel.send(envelope)` and treats a rejected promise as
 * a transient failure (→ retry with backoff).
 *
 * Interface every channel implements:
 *   name: string
 *   send({ to, toName, from, subject, text, html, meta }) → Promise<{ providerMessageId?: string }>
 *   verify?() → Promise<void>      optional boot-time connectivity probe (never fatal)
 *   close?() → Promise<void>       release pooled connections on shutdown
 *   describe() → object            shown in /health (no secrets)
 *
 * Adding a channel (SMS, push, …) = one new file here + one enum value in
 * config; consumer logic is untouched.
 */
import { createConsoleChannel } from './console.js';
import { createSmtpChannel } from './smtp.js';

export function createChannel(delivery, logger) {
  switch (delivery.channel) {
    case 'console': return createConsoleChannel(delivery, logger);
    case 'smtp': return createSmtpChannel(delivery, logger);
    default: throw new Error(`unknown delivery channel "${delivery.channel}"`);
  }
}
