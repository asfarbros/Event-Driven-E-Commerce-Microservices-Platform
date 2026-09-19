/**
 * Cart — the PERMANENT source of truth, one document per user, in cart_db.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THE CART DOES NOT STORE PRICE.                                          │
 * │ A line item is exactly { productId, quantity }. Prices are fetched live │
 * │ from the Catalog service on every read and computed into totals then.   │
 * │ There is no price field here, none in Redis, and adding one would be a  │
 * │ money bug: a price copied at add-time is stale by checkout-time.        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Identity: `userId` is the Clerk user id injected by the API Gateway as
 * X-User-Id. It is the ONLY key by which a cart is ever looked up.
 *
 * Indexes
 *   { userId: 1 } UNIQUE — one cart per user; every read and write is a
 *   point lookup on this index. Nothing else is ever queried.
 *
 * A cart lives until the user clears it (the document is removed) — there is
 * no TTL in MongoDB. The Redis copy expires; this does not.
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;

const lineItemSchema = new Schema(
  {
    productId: { type: String, required: true, match: /^[0-9a-f]{24}$/ },
    quantity:  { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'quantity must be an integer' } },
  },
  { _id: false },
);

const cartSchema = new Schema(
  {
    userId: { type: String, required: true, match: /^[A-Za-z0-9._-]{1,128}$/ },
    items:  { type: [lineItemSchema], default: [] },
  },
  { timestamps: true, versionKey: false, collection: 'carts' },
);

cartSchema.index({ userId: 1 }, { unique: true, name: 'user_unique' });

/** Contents as cached in Redis and returned by write endpoints. No prices. */
export function toContents(doc, userId) {
  return {
    userId,
    items: (doc?.items ?? []).map((i) => ({ productId: i.productId, quantity: i.quantity })),
    updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

export const Cart = mongoose.models.Cart ?? mongoose.model('Cart', cartSchema);
