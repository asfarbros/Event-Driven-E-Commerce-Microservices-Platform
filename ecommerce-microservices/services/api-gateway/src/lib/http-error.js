/**
 * An error that carries an HTTP status and a stable machine-readable code.
 * The global error handler turns these into `{ error, message, requestId }`.
 * Anything that is NOT an HttpError is treated as an unexpected 500 and its
 * message is never sent to the client.
 */
export class HttpError extends Error {
  /**
   * @param {number} status   HTTP status code
   * @param {string} code     snake_case identifier, e.g. 'unauthorized'
   * @param {string} message  safe, client-facing explanation
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}
