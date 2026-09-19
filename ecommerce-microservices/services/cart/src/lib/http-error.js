/**
 * Error carrying an HTTP status and a stable machine-readable code — same
 * contract as the gateway: `{ error, message, requestId }` on the wire, plus
 * an optional `details` array for field-level validation problems.
 */
export class HttpError extends Error {
  /**
   * @param {number} status    HTTP status code
   * @param {string} code      snake_case identifier, e.g. 'validation_error'
   * @param {string} message   safe, client-facing explanation
   * @param {Array<{field: string, message: string}>} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.expose = true;
    if (details) this.details = details;
  }
}
