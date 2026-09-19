/**
 * Cart operations: cache-aside reads, MongoDB-first writes, live pricing.
 *
 * READ  (getCartContents)
 *   1. Redis GET cart:<userId>            → HIT: use it (X-Cache: HIT)
 *   2. MISS / Redis down → MongoDB findOne, then Redis SET with TTL
 *   3. Caller prices the contents LIVE via Catalog (never cached)
 *
 * WRITE (add / setQuantity / remove / clear)
 *   1. MongoDB first — the permanent truth
 *   2. then Redis SET (write-through of contents) or DEL
 *   3. a Redis failure is logged and IGNORED: the write already succeeded
 *
 * Only { productId, quantity } ever reaches Redis or MongoDB.
 */
import { Cart, toContents } from '../models/cart.js';
import { HttpError } from '../lib/http-error.js';
import { CatalogUnavailableError } from '../clients/catalog.js';

export function createCartService({ cache, catalog, limits }) {
  // ---------------------------------------------------------------------------
  // Contents (cache-aside)
  // ---------------------------------------------------------------------------

  /** @returns {{ contents, cache: 'hit'|'miss'|'bypass'|'unavailable' }} */
  async function getCartContents(userId, { bypassCache = false, log }) {
    if (!bypassCache) {
      const cached = await cache.getContents(userId, log);
      if (cached.available && cached.hit) {
        log.debug({ source: 'redis' }, 'cart contents served from cache');
        return { contents: cached.value, cache: 'hit' };
      }
      const doc = await Cart.findOne({ userId }).lean();
      const contents = toContents(doc, userId);
      const status = cached.available ? 'miss' : 'unavailable';
      log.debug({ source: 'mongodb', reason: status }, 'cart contents loaded from MongoDB');
      if (cached.available) await cache.setContents(userId, contents, log); // repopulate
      return { contents, cache: status };
    }
    const doc = await Cart.findOne({ userId }).lean();
    return { contents: toContents(doc, userId), cache: 'bypass' };
  }

  /** Persist a full item list (MongoDB first, then Redis). */
  async function saveItems(userId, items, log) {
    const doc = await Cart.findOneAndUpdate(
      { userId },
      { $set: { items }, $setOnInsert: { userId } },
      { upsert: true, new: true, runValidators: true },
    ).lean();
    const contents = toContents(doc, userId);
    await cache.setContents(userId, contents, log);
    return contents;
  }

  /** Read current items for a write, straight from MongoDB (never trust the cache for read-modify-write). */
  async function currentItems(userId) {
    const doc = await Cart.findOne({ userId }, { items: 1 }).lean();
    return doc?.items?.map((i) => ({ productId: i.productId, quantity: i.quantity })) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Pricing (live, never stored)
  // ---------------------------------------------------------------------------

  /**
   * Price a set of contents with ONE Catalog call.
   * @returns {{ status: 'complete'|'partial'|'unavailable', items, currency, totalInPaise, pricedAt, reason }}
   */
  async function priceContents(contents, { requestId, log }) {
    const { items } = contents;
    if (items.length === 0) {
      return { status: 'complete', items: [], currency: null, totalInPaise: 0, pricedAt: new Date().toISOString(), reason: null };
    }

    let result;
    try {
      result = await catalog.getPrices(items.map((i) => i.productId), { requestId, log });
    } catch (err) {
      if (err instanceof CatalogUnavailableError) {
        return {
          status: 'unavailable',
          items: items.map((i) => ({ ...i, priceStatus: 'unavailable' })),
          currency: null, totalInPaise: null, pricedAt: null, reason: `catalog_${err.reason}`,
        };
      }
      throw err;
    }

    const priced = new Map(result.prices.map((p) => [p.productId, p]));
    const unavailable = new Map(result.unavailable.map((u) => [u.productId, u.reason]));
    let allPriced = true;
    const currencies = new Set();
    let total = 0;

    const lines = items.map((i) => {
      const p = priced.get(i.productId);
      if (!p) {
        allPriced = false;
        return { ...i, priceStatus: unavailable.get(i.productId) ?? 'not_found' };
      }
      const lineTotal = p.priceInPaise * i.quantity; // integers × integer — exact
      total += lineTotal;
      currencies.add(p.currency);
      return { ...i, priceStatus: 'ok', name: p.name, sku: p.sku, unitPriceInPaise: p.priceInPaise, lineTotalInPaise: lineTotal, currency: p.currency };
    });

    const currency = currencies.size === 1 ? [...currencies][0] : null;
    return {
      status: allPriced ? 'complete' : 'partial',
      items: lines,
      currency,
      // A total is only a total when EVERY line is priced.
      totalInPaise: allPriced ? total : null,
      pricedAt: result.asOf,
      reason: allPriced ? null : 'some_items_unavailable',
    };
  }

  function summarize(contents) {
    return { itemCount: contents.items.length, totalQuantity: contents.items.reduce((n, i) => n + i.quantity, 0) };
  }

  /** GET / — degrades gracefully: the cart is always returned. */
  async function getCart(userId, { requestId, log, bypassCache = false }) {
    const { contents, cache: cacheStatus } = await getCartContents(userId, { bypassCache, log });
    const pricing = await priceContents(contents, { requestId, log });
    return {
      cache: cacheStatus,
      body: {
        userId,
        items: pricing.items,
        ...summarize(contents),
        currency: pricing.currency,
        totalInPaise: pricing.totalInPaise,
        pricing: {
          status: pricing.status,
          pricedItems: pricing.items.filter((i) => i.priceStatus === 'ok').length,
          unpricedItems: pricing.items.filter((i) => i.priceStatus !== 'ok').length,
          pricedAt: pricing.pricedAt,
          reason: pricing.reason,
        },
        degraded: pricing.status === 'unavailable',
        updatedAt: contents.updatedAt,
      },
    };
  }

  /**
   * GET /snapshot — STRICT. Reads MongoDB directly (never the cache) and
   * fails unless every line has a live price. Checkout must never proceed
   * on incomplete pricing.
   */
  async function getSnapshot(userId, { requestId, log }) {
    const { contents } = await getCartContents(userId, { bypassCache: true, log });
    if (contents.items.length === 0) throw new HttpError(409, 'cart_empty', 'The cart is empty; there is nothing to check out');

    const pricing = await priceContents(contents, { requestId, log });
    if (pricing.status === 'unavailable') {
      throw new HttpError(503, 'pricing_unavailable', 'Live prices could not be fetched from the catalog; checkout cannot proceed. Please try again.');
    }
    if (pricing.status === 'partial') {
      const problems = pricing.items.filter((i) => i.priceStatus !== 'ok').map((i) => ({ field: `items.${i.productId}`, message: i.priceStatus }));
      throw new HttpError(409, 'cart_has_unavailable_items', 'Some items in the cart are no longer available; remove them before checking out', problems);
    }
    if (!pricing.currency) throw new HttpError(409, 'mixed_currencies', 'Cart items are priced in different currencies');

    return {
      userId,
      items: pricing.items.map(({ priceStatus, ...line }) => line),
      ...summarize(contents),
      currency: pricing.currency,
      totalInPaise: pricing.totalInPaise,
      pricedAt: pricing.pricedAt,
      snapshotAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Writes (MongoDB first, then Redis)
  // ---------------------------------------------------------------------------

  /** Verify a product is purchasable before storing it. */
  async function assertPurchasable(productId, { requestId, log }) {
    let result;
    try {
      result = await catalog.getPrices([productId], { requestId, log });
    } catch (err) {
      if (err instanceof CatalogUnavailableError) {
        throw new HttpError(503, 'catalog_unavailable', 'The product cannot be verified right now because the catalog is unavailable. Please try again.');
      }
      throw err;
    }
    const problem = result.unavailable.find((u) => u.productId === productId);
    if (problem?.reason === 'not_found') throw new HttpError(404, 'product_not_found', `Product ${productId} does not exist`);
    if (problem) throw new HttpError(400, 'product_unavailable', `Product ${productId} is no longer available`);
    return result.prices.find((p) => p.productId === productId);
  }

  function withContents(contents) {
    return { ...contents, ...summarize(contents) };
  }

  async function addItem(userId, { productId, quantity }, ctx) {
    await assertPurchasable(productId, ctx);
    const items = await currentItems(userId);
    const existing = items.find((i) => i.productId === productId);
    if (existing) {
      const next = existing.quantity + quantity;
      if (next > limits.maxQuantityPerItem) {
        throw new HttpError(400, 'quantity_limit_exceeded', `Quantity for this product would be ${next}; the maximum is ${limits.maxQuantityPerItem}`, [{ field: 'body.quantity', message: `at most ${limits.maxQuantityPerItem - existing.quantity} more can be added` }]);
      }
      existing.quantity = next;
    } else {
      if (items.length >= limits.maxLineItems) {
        throw new HttpError(400, 'cart_full', `The cart already holds the maximum of ${limits.maxLineItems} distinct items`);
      }
      items.push({ productId, quantity });
    }
    const contents = await saveItems(userId, items, ctx.log);
    ctx.log.info({ productId, quantity, merged: Boolean(existing) }, 'cart item added');
    return withContents(contents);
  }

  async function setQuantity(userId, { productId, quantity }, ctx) {
    const items = await currentItems(userId);
    const existing = items.find((i) => i.productId === productId);
    if (!existing) throw new HttpError(404, 'item_not_in_cart', `Product ${productId} is not in the cart`);
    existing.quantity = quantity;
    const contents = await saveItems(userId, items, ctx.log);
    ctx.log.info({ productId, quantity }, 'cart item quantity set');
    return withContents(contents);
  }

  async function removeItem(userId, { productId }, ctx) {
    const items = await currentItems(userId);
    const next = items.filter((i) => i.productId !== productId);
    if (next.length === items.length) throw new HttpError(404, 'item_not_in_cart', `Product ${productId} is not in the cart`);
    const contents = await saveItems(userId, next, ctx.log);
    ctx.log.info({ productId }, 'cart item removed');
    return withContents(contents);
  }

  async function clearCart(userId, ctx) {
    await Cart.deleteOne({ userId });     // MongoDB first
    await cache.remove(userId, ctx.log);  // then the copy
    ctx.log.info('cart cleared');
  }

  return { getCart, getSnapshot, addItem, setQuantity, removeItem, clearCart };
}
