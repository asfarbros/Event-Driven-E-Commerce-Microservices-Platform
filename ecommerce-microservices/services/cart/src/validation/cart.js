/**
 * zod schemas. The cart key is NEVER taken from the body, query or URL — only
 * from X-User-Id — so no schema here even has a userId field, and bodies are
 * `.strict()` so a smuggled `userId` is rejected as an unknown key.
 */
import { z } from 'zod';

export const productId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex product id').transform((s) => s.toLowerCase());

export function buildSchemas({ limits }) {
  const quantity = z.number({ error: 'must be a number' })
    .int('must be a whole number')
    .min(1, 'must be at least 1')
    .max(limits.maxQuantityPerItem, `must be at most ${limits.maxQuantityPerItem}`);

  return {
    productParams: z.object({ productId }),
    addItemBody: z.object({ productId, quantity: quantity.default(1) }).strict(),
    setQuantityBody: z.object({ quantity }).strict(),
  };
}
