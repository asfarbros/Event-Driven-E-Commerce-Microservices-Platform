/**
 * Failure classification — the distinction the whole retry design rests on.
 *
 *   UnprocessableError  the message can NEVER succeed (fails validation,
 *                       unknown command type, user no longer exists, …).
 *                       Retrying is pointless → straight to the DLQ with the
 *                       reason attached, no attempts consumed.
 *
 *   anything else       transient (SMTP down, Clerk 5xx, Mongo unreachable,
 *                       timeout). Worth retrying with backoff; after
 *                       maxAttempts it is dead-lettered as `exhausted`.
 */
export class UnprocessableError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'UnprocessableError';
    this.code = code;
    this.details = details;
  }
}

/** Compact, log-safe description of any error (no stack, no secrets). */
export function describeError(err) {
  if (!err) return { name: 'Error', message: 'unknown' };
  const out = { name: err.name || 'Error', message: String(err.message || err).split('\n')[0] };
  if (err.code) out.code = err.code;
  if (err.details) out.details = err.details;
  return out;
}
