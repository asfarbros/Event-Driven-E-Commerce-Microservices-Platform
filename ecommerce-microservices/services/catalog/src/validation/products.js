/**
 * zod schemas for every product endpoint. Built from config because the
 * pagination cap, id-batch cap and default currency come from the environment.
 *
 * Conventions
 *   - Bodies are `.strict()`: unknown fields are an error (catches `price`
 *     vs `priceInPaise` typos instead of silently ignoring them).
 *   - Query objects strip unknown keys (tracking params etc. are harmless).
 *   - `limit` above the maximum is CAPPED, not rejected — a client asking for
 *     10 000 gets the max and the pagination metadata tells it so.
 *   - Everything that ends up in a Mongo filter is a primitive validated here.
 */
import { z } from 'zod';
import { SKU_PATTERN, CATEGORY_PATTERN } from '../models/product.js';

export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex product id');

const category = z.string().trim().toLowerCase().regex(CATEGORY_PATTERN, 'must be a lowercase slug such as "home-kitchen"').max(64);
const sku = z.string().trim().toUpperCase().regex(SKU_PATTERN, 'must be 2-48 uppercase letters, digits or dashes, e.g. "AUD-NB-001"');
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 code such as INR');
const imageUrl = z.url({ protocol: /^https?$/ }).max(2048).nullable();
// Integer in the smallest currency unit. Floats and negatives are rejected here
// and again by the Mongoose schema.
const priceInPaise = z.number({ error: 'must be a number' }).int('must be an integer amount in paise (no decimals)').min(0, 'must be >= 0');

export const SORT_OPTIONS = ['newest', 'price_asc', 'price_desc', 'name_asc', 'relevance'];

export function buildSchemas({ pagination, priceLookupMaxIds, defaultCurrency }) {
  const listQuery = z.object({
    page: z.coerce.number({ error: 'must be a whole number >= 1' }).int('must be a whole number').min(1, 'must be >= 1').default(1),
    limit: z.coerce.number({ error: 'must be a whole number >= 1' }).int('must be a whole number').min(1, 'must be >= 1')
      .default(pagination.defaultLimit)
      .transform((n) => Math.min(n, pagination.maxLimit)),
    category: category.optional(),
    q: z.string().trim().min(1, 'must not be empty').max(100, 'must be at most 100 characters')
      .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, '')).optional(),
    sort: z.enum(SORT_OPTIONS, { error: `must be one of ${SORT_OPTIONS.join(', ')}` }).optional(),
    // Admin-oriented; see README (TODO: restrict once roles exist).
    includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  });

  const idParams = z.object({ id: objectId });

  // Base fields WITHOUT defaults. The update schema is derived from this, not
  // from createBody: in zod 4 `.partial()` still applies `.default()` values,
  // so `PUT {}` would have silently set isActive: true and re-activated a
  // soft-deleted product. Defaults belong to creation only.
  const productFields = z.object({
    name: z.string().trim().min(1, 'is required').max(200),
    description: z.string().trim().min(1, 'is required').max(5000),
    priceInPaise,
    currency,
    category,
    imageUrl: imageUrl.optional(),
    sku,
    isActive: z.boolean(),
  });

  const createBody = productFields.extend({
    currency: currency.default(defaultCurrency),
    isActive: z.boolean().default(true),
  }).strict();

  const updateBody = productFields.partial().strict()
    .refine((b) => Object.keys(b).length > 0, { message: 'must include at least one field to update' });

  const pricesBody = z.object({
    productIds: z.array(objectId, { error: 'must be an array of product ids' })
      .min(1, 'must contain at least one product id')
      .max(priceLookupMaxIds, `must contain at most ${priceLookupMaxIds} product ids`),
  }).strict();

  return { listQuery, idParams, createBody, updateBody, pricesBody };
}
