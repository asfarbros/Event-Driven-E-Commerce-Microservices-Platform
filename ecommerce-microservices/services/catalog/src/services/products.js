/**
 * Product data access. Every Mongo query in the service lives here, built
 * only from values that already passed validation.
 */
import mongoose from 'mongoose';
import { Product, toPublicProduct } from '../models/product.js';
import { HttpError } from '../lib/http-error.js';

const { ObjectId } = mongoose.Types;

// Fields the public listing returns (no need to ship the 5 KB description
// for every card — GET /products/:id returns everything).
const LISTING_PROJECTION = { name: 1, priceInPaise: 1, currency: 1, category: 1, imageUrl: 1, sku: 1, isActive: 1, createdAt: 1, updatedAt: 1 };

const SORTS = {
  newest:     { createdAt: -1, _id: -1 },
  price_asc:  { priceInPaise: 1, _id: 1 },
  price_desc: { priceInPaise: -1, _id: -1 },
  name_asc:   { name: 1, _id: 1 },
  relevance:  { score: { $meta: 'textScore' }, _id: 1 },
};

export async function listProducts({ page, limit, category, q, sort, includeInactive }) {
  const filter = {};
  if (!includeInactive) filter.isActive = true;
  if (category) filter.category = category;
  if (q) filter.$text = { $search: q };

  const effectiveSort = sort ?? (q ? 'relevance' : 'newest');
  if (effectiveSort === 'relevance' && !q) {
    throw new HttpError(400, 'validation_error', 'sort=relevance requires a search query (q)', [{ field: 'query.sort', message: 'requires q' }]);
  }

  const projection = { ...LISTING_PROJECTION, ...(q ? { score: { $meta: 'textScore' } } : {}) };
  const skip = (page - 1) * limit;

  // Two independent queries, run concurrently: the page and the total.
  const [docs, total] = await Promise.all([
    Product.find(filter, projection).sort(SORTS[effectiveSort]).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    items: docs.map(toPublicProduct),
    pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
    sort: effectiveSort,
    filters: { ...(category ? { category } : {}), ...(q ? { q } : {}), includeInactive },
  };
}

/** Active products only; a soft-deleted product is indistinguishable from a missing one. */
export async function getActiveProduct(id) {
  const doc = await Product.findOne({ _id: new ObjectId(id), isActive: true }).lean();
  if (!doc) throw new HttpError(404, 'product_not_found', `Product ${id} was not found`);
  return toPublicProduct(doc);
}

/**
 * Bulk price lookup — the contract Cart and Order depend on.
 *
 * ONE query: { _id: { $in: ids } } with a projection of only the fields that
 * matter, regardless of how many ids are requested. Ids are de-duplicated
 * first; every requested id appears exactly once in either `prices` or
 * `unavailable`, so a consumer can never silently miss one.
 */
export async function lookupPrices(productIds) {
  const unique = [...new Set(productIds)];
  const docs = await Product.find(
    { _id: { $in: unique.map((id) => new ObjectId(id)) } },
    { name: 1, sku: 1, priceInPaise: 1, currency: 1, isActive: 1 },
  ).lean();

  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const prices = [];
  const unavailable = [];
  for (const id of unique) {
    const doc = byId.get(id);
    if (!doc) unavailable.push({ productId: id, reason: 'not_found' });
    else if (!doc.isActive) unavailable.push({ productId: id, reason: 'inactive' });
    else prices.push({ productId: id, sku: doc.sku, name: doc.name, priceInPaise: doc.priceInPaise, currency: doc.currency });
  }
  return { prices, unavailable, asOf: new Date().toISOString() };
}

export async function createProduct(input) {
  const doc = await Product.create(input); // E11000 on duplicate sku → 409 via error handler
  return toPublicProduct(doc);
}

export async function updateProduct(id, changes) {
  const doc = await Product.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: changes },
    { new: true, runValidators: true, context: 'query' },
  ).lean();
  if (!doc) throw new HttpError(404, 'product_not_found', `Product ${id} was not found`);
  return toPublicProduct(doc);
}

/** Soft delete: the document stays (with its price) but leaves every public view. */
export async function deactivateProduct(id) {
  const doc = await Product.findOneAndUpdate(
    { _id: new ObjectId(id), isActive: true },
    { $set: { isActive: false } },
    { new: true },
  ).lean();
  if (!doc) throw new HttpError(404, 'product_not_found', `Product ${id} was not found or is already inactive`);
  return toPublicProduct(doc);
}
