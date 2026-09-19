/**
 * Product — the ONLY place in OrderFlow where a product's price lives.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ MONEY RULE                                                              │
 * │ `priceInPaise` is an INTEGER in the smallest unit of `currency`         │
 * │ (paise for INR: ₹1,299.00 → 129900). Never a float, never a decimal    │
 * │ string. Floats cannot represent 0.1 exactly, so summing cart lines or   │
 * │ applying percentages in floating point produces off-by-a-paisa totals   │
 * │ that show up as real reconciliation bugs at checkout. Integers add      │
 * │ exactly. Every API response carries both `priceInPaise` and `currency`  │
 * │ so the unit is never ambiguous to a consumer.                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * INDEXES (this is a read-heavy service; every index below serves a query
 * the API actually runs — see services/products.js):
 *
 *  1. { sku: 1 } UNIQUE
 *     Guarantees no two products share a SKU (duplicate inserts fail with
 *     E11000 → mapped to HTTP 409) and makes lookup/upsert by SKU (seed
 *     script, future imports) an index seek.
 *
 *  2. { isActive: 1, category: 1, createdAt: -1 }
 *     The default listing: filter on isActive (always), optionally on
 *     category, sorted newest-first. Fields follow the ESR rule — Equality
 *     (isActive, category) before Sort (createdAt) — so MongoDB can walk the
 *     index in sort order and skip/limit without an in-memory sort. When no
 *     category is given the index is still used via its isActive prefix.
 *
 *  3. { isActive: 1, category: 1, priceInPaise: 1 }
 *     Same equality prefix, sorted by price, for `sort=price_asc|price_desc`
 *     (a single ascending index serves both directions).
 *
 *  4. { name: 'text', description: 'text' } weighted 10:2
 *     Full-text search for `?q=`. MongoDB allows one text index per
 *     collection; name matches are weighted far above description matches so
 *     "headphones" ranks the product called Headphones above a product that
 *     merely mentions them. Results are ordered by textScore when searching.
 *
 *  _id is indexed by default and serves GET /products/:id and the bulk price
 *  lookup ({ _id: { $in: [...] } } — one query, one index scan).
 *
 * Soft delete: `isActive: false` hides a product from every public read and
 * from price lookups (reported as "inactive"), but the document — and its
 * price history for past orders — stays in the collection.
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;

export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,47}$/;
export const CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const productSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
    description:  { type: String, required: true, trim: true, maxlength: 5000 },
    // Integer, smallest currency unit. See MONEY RULE above.
    priceInPaise: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'priceInPaise must be an integer' } },
    currency:     { type: String, required: true, uppercase: true, match: /^[A-Z]{3}$/ },
    category:     { type: String, required: true, trim: true, lowercase: true, match: CATEGORY_PATTERN },
    imageUrl:     { type: String, trim: true, maxlength: 2048 },
    sku:          { type: String, required: true, trim: true, uppercase: true, match: SKU_PATTERN },
    isActive:     { type: Boolean, required: true, default: true },
  },
  {
    timestamps: true,       // createdAt / updatedAt
    versionKey: false,
    collection: 'products',
  },
);

productSchema.index({ sku: 1 }, { unique: true, name: 'sku_unique' });
productSchema.index({ isActive: 1, category: 1, createdAt: -1 }, { name: 'listing_newest' });
productSchema.index({ isActive: 1, category: 1, priceInPaise: 1 }, { name: 'listing_price' });
productSchema.index(
  { name: 'text', description: 'text' },
  { name: 'product_text', weights: { name: 10, description: 2 }, default_language: 'english' },
);

/** Public JSON shape. `id` not `_id`; unit is explicit in the field name. */
export function toPublicProduct(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    description: doc.description,
    priceInPaise: doc.priceInPaise,
    currency: doc.currency,
    category: doc.category,
    imageUrl: doc.imageUrl ?? null,
    sku: doc.sku,
    isActive: doc.isActive,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const Product = mongoose.models.Product ?? mongoose.model('Product', productSchema);
