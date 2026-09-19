/**
 * Input validation at the edge (zod).
 *
 * `validate({ body, query, params })` parses each part with the given schema
 * and stores the CLEAN, typed result on `req.validated`. Handlers only ever
 * read from `req.validated` — never from `req.body` / `req.query` directly —
 * so nothing unvalidated can reach a Mongo query. (Express 5 exposes
 * `req.query` as a read-only getter, which is another reason not to mutate it.)
 *
 * Failures become 400 `validation_error` with field-level details:
 *   { error, message, requestId, details: [{ field: "body.priceInPaise", message }] }
 */
import { HttpError } from '../lib/http-error.js';

export function validate(schemas) {
  const parts = Object.entries(schemas);
  return (req, res, next) => {
    const validated = {};
    const details = [];

    for (const [part, schema] of parts) {
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          const field = [part, ...issue.path].join('.');
          details.push({ field, message: issue.message });
        }
      }
    }

    if (details.length > 0) {
      const summary = details.slice(0, 3).map((d) => `${d.field}: ${d.message}`).join('; ');
      const more = details.length > 3 ? ` (+${details.length - 3} more)` : '';
      return next(new HttpError(400, 'validation_error', `Validation failed — ${summary}${more}`, details));
    }
    req.validated = validated;
    next();
  };
}
