/**
 * Request body size limit WITHOUT buffering.
 *
 * Bodies are streamed straight to the downstream service (so uploads and large
 * payloads work), which means we cannot count bytes here without breaking the
 * stream. Instead the declared Content-Length is checked up front and oversized
 * requests are refused with 413 before a single body byte is read. Browsers
 * always send Content-Length for JSON/FormData bodies; a chunked request with
 * no length is passed through and the receiving service enforces its own limit.
 */
import bytes from 'bytes';
import { HttpError } from '../lib/http-error.js';

export function bodyLimit({ bodyLimitBytes }) {
  const human = bytes.format(bodyLimitBytes, { unitSeparator: ' ' });
  return (req, res, next) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > bodyLimitBytes) {
      return next(new HttpError(413, 'payload_too_large', `Request body exceeds the ${human} limit`));
    }
    next();
  };
}
