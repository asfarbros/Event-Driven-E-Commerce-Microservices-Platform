/**
 * Integration tests: real MongoDB (cart_test_db) + real Redis (carttest:*)
 * from the Step 0 infrastructure, and a controllable fake Catalog.
 * Run with `npm test` while `docker compose … up` is running.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { loadConfig, ConfigError } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { createMongoConnector } from '../src/db/mongo.js';
import { createCartCache } from '../src/db/redis.js';
import { createCatalogClient } from '../src/clients/catalog.js';
import { createApp } from '../src/app.js';
import { startServer } from '../src/server.js';
import { Cart } from '../src/models/cart.js';
import { startFakeCatalog } from './helpers/fake-catalog.js';
import { testEnv, TEST_DB, TEST_PREFIX } from './helpers/test-env.js';

const logger = createLogger({ level: 'silent' });
const ALICE = { 'X-User-Id': 'user_alice' };
const BOB = { 'X-User-Id': 'user_bob' };
const NIL = '000000000000000000000000';
const oid = (n) => n.toString(16).padStart(24, '0');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let catalogFx, mongo, cache, catalog, server, shutdown, base, config;

const json = async (pending) => { const res = await pending; return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json() }; };
const call = (method, path, { headers = {}, body } = {}) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const add = (headers, productId, quantity) => json(call('POST', '/items', { headers, body: quantity === undefined ? { productId } : { productId, quantity } }));
const get = (headers, path = '/') => json(call('GET', path, { headers }));

async function bootApp(overrides = {}) {
  const cfg = loadConfig(testEnv({ CATALOG_SERVICE_URL: catalogFx.url, ...overrides }));
  const c = createCartCache(cfg.redis, logger);
  await c.connect();
  const k = createCatalogClient(cfg.catalog, logger);
  const app = createApp(cfg, logger, { version: 'test', cache: c, catalog: k });
  const started = startServer(app, { port: 0, host: '127.0.0.1', shutdownTimeoutMs: cfg.shutdownTimeoutMs }, logger);
  const { port } = await started.listening;
  return { cfg, cache: c, catalog: k, server: started.server, shutdown: started.shutdown, base: `http://127.0.0.1:${port}` };
}

before(async () => {
  catalogFx = await startFakeCatalog();
  // Three purchasable products, one inactive.
  catalogFx.fixture.products.set(oid(1), { name: 'Nimbus Headphones', sku: 'ELC-1', priceInPaise: 499900, currency: 'INR', isActive: true });
  catalogFx.fixture.products.set(oid(2), { name: 'Monsoon Ledger', sku: 'BK-1', priceInPaise: 39900, currency: 'INR', isActive: true });
  catalogFx.fixture.products.set(oid(3), { name: 'Yoga Mat', sku: 'SP-1', priceInPaise: 119900, currency: 'INR', isActive: true });
  catalogFx.fixture.products.set(oid(4), { name: 'Old Kettle', sku: 'HK-9', priceInPaise: 99900, currency: 'INR', isActive: false });

  config = loadConfig(testEnv({ CATALOG_SERVICE_URL: catalogFx.url }));
  mongo = createMongoConnector(config.mongo, logger);
  assert.equal(await mongo.connectWithRetry(), true, 'MongoDB must be reachable');
  assert.equal(mongoose.connection.name, TEST_DB);
  await mongoose.connection.dropDatabase();
  await Cart.syncIndexes();

  ({ cache, catalog, server, shutdown, base } = await bootApp());
  assert.equal(cache.describe().connected, true, 'Redis must be reachable');
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await cache._invalidateNamespace();
  await cache.stop();
  catalog.stop();
  await mongoose.connection.dropDatabase();
  await mongo.stop();
  await catalogFx.close();
});

beforeEach(async () => {
  await Cart.deleteMany({});
  await cache._invalidateNamespace();
  catalogFx.fixture.mode = 'ok';
  catalogFx.fixture.calls.length = 0;
});

const redisKey = (userId) => `${TEST_PREFIX}${userId}`;

// ---------------------------------------------------------------------------
describe('health & identity', () => {
  test('GET /health reports MongoDB, Redis and the breaker; /ready is 200', async () => {
    const r = await get({}, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.db.state, 'connected');
    assert.equal(r.body.db.database, TEST_DB);
    assert.equal(r.body.redis.connected, true);
    assert.equal(r.body.catalogBreaker.state, 'closed');
    assert.equal((await call('GET', '/ready')).status, 200);
  });

  test('every cart route requires X-User-Id → 401 otherwise (no fallback)', async () => {
    for (const [m, p] of [['GET', '/'], ['POST', '/items'], ['PATCH', `/items/${oid(1)}`], ['DELETE', `/items/${oid(1)}`], ['DELETE', '/'], ['GET', '/snapshot']]) {
      const r = await json(call(m, `${p}?userId=user_alice`, { body: m === 'POST' || m === 'PATCH' ? { productId: oid(1), quantity: 1, userId: 'user_alice' } : undefined }));
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.equal(r.body.error, 'unauthorized');
    }
    assert.equal((await call('GET', '/', { headers: { 'X-User-Id': 'bad id!' } })).status, 401);
  });
});

// ---------------------------------------------------------------------------
describe('cart operations (MongoDB truth, Redis copy)', () => {
  test('add / merge / set / remove / clear', async () => {
    let r = await add(ALICE, oid(1), 2);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, [{ productId: oid(1), quantity: 2 }]);

    r = await add(ALICE, oid(1), 3);
    assert.deepEqual(r.body.items, [{ productId: oid(1), quantity: 5 }], 'same product merges into one line');

    r = await add(ALICE, oid(2)); // default quantity 1
    assert.equal(r.body.itemCount, 2);
    assert.equal(r.body.totalQuantity, 6);

    r = await json(call('PATCH', `/items/${oid(2)}`, { headers: ALICE, body: { quantity: 4 } }));
    assert.equal(r.body.items.find((i) => i.productId === oid(2)).quantity, 4);

    r = await json(call('DELETE', `/items/${oid(1)}`, { headers: ALICE }));
    assert.deepEqual(r.body.items, [{ productId: oid(2), quantity: 4 }]);

    assert.equal((await call('DELETE', '/', { headers: ALICE })).status, 204);
    r = await get(ALICE);
    assert.deepEqual(r.body.items, []);
    assert.equal(r.body.totalInPaise, 0);
  });

  test('contents persist in MongoDB and contain NO price', async () => {
    await add(ALICE, oid(1), 2);
    await add(ALICE, oid(3), 1);
    const doc = await Cart.findOne({ userId: 'user_alice' }).lean();
    assert.ok(doc);
    assert.deepEqual(doc.items, [{ productId: oid(1), quantity: 2 }, { productId: oid(3), quantity: 1 }]);
    assert.doesNotMatch(JSON.stringify(doc), /price|paise/i);
  });

  test('PATCH / DELETE on an item that is not in the cart → 404', async () => {
    assert.equal((await call('PATCH', `/items/${oid(1)}`, { headers: ALICE, body: { quantity: 1 } })).status, 404);
    assert.equal((await call('DELETE', `/items/${oid(1)}`, { headers: ALICE })).status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('cache-aside', () => {
  test('write-through: after a write the next read is a HIT; Redis holds contents only, with TTL', async () => {
    await add(ALICE, oid(1), 2);
    const r = await get(ALICE);
    assert.equal(r.headers.get('x-cache'), 'HIT');
    const raw = await cache._client.get(redisKey('user_alice'));
    const cached = JSON.parse(raw);
    assert.deepEqual(cached.items, [{ productId: oid(1), quantity: 2 }]);
    assert.doesNotMatch(raw, /price|paise/i, 'no price in Redis');
    const ttl = await cache._client.ttl(redisKey('user_alice'));
    assert.ok(ttl > 0 && ttl <= 60, `ttl ${ttl}`);
  });

  test('CACHE MISS RECOVERY: deleting the Redis key loses nothing — full cart from MongoDB, then repopulated', async () => {
    await add(ALICE, oid(1), 2);
    await add(ALICE, oid(2), 3);
    assert.equal(await cache._client.del(redisKey('user_alice')), 1);

    const miss = await get(ALICE);
    assert.equal(miss.headers.get('x-cache'), 'MISS');
    assert.deepEqual(miss.body.items.map((i) => [i.productId, i.quantity, i.priceStatus]), [[oid(1), 2, 'ok'], [oid(2), 3, 'ok']]);
    assert.equal(miss.body.totalInPaise, 499900 * 2 + 39900 * 3);

    assert.equal(await cache._client.exists(redisKey('user_alice')), 1, 'repopulated');
    assert.equal((await get(ALICE)).headers.get('x-cache'), 'HIT');
  });

  test('reconnect-after-outage invalidation clears stale copies', async () => {
    await add(ALICE, oid(1), 1);
    // Simulate a write that happened while Redis was down: Mongo changes, Redis keeps the old copy.
    await Cart.updateOne({ userId: 'user_alice' }, { $set: { items: [{ productId: oid(1), quantity: 7 }] } });
    assert.equal(JSON.parse(await cache._client.get(redisKey('user_alice'))).items[0].quantity, 1, 'stale copy in Redis');
    const removed = await cache._invalidateNamespace();
    assert.ok(removed >= 1);
    const r = await get(ALICE);
    assert.equal(r.headers.get('x-cache'), 'MISS');
    assert.equal(r.body.items[0].quantity, 7);
  });

  test('REDIS DOWN: an instance whose Redis is unreachable still works fully against MongoDB', async () => {
    const down = await bootApp({ REDIS_PORT: '9' });
    try {
      const h = await json(fetch(`${down.base}/health`));
      assert.equal(h.body.status, 'degraded');
      assert.equal(h.body.redis.connected, false);
      assert.equal(h.body.db.state, 'connected');
      assert.equal((await fetch(`${down.base}/ready`)).status, 200, 'ready without Redis');

      const w = await json(fetch(`${down.base}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ALICE }, body: JSON.stringify({ productId: oid(1), quantity: 2 }) }));
      assert.equal(w.status, 200);
      const r = await json(fetch(`${down.base}/`, { headers: ALICE }));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-cache'), 'UNAVAILABLE');
      assert.equal(r.body.totalInPaise, 999800);
      assert.equal((await Cart.findOne({ userId: 'user_alice' }).lean()).items[0].quantity, 2, 'written to MongoDB');
    } finally {
      down.server.closeAllConnections(); down.server.close(); await down.cache.stop(); down.catalog.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('live pricing via Catalog', () => {
  test('one bulk call per read regardless of line items; X-Request-Id forwarded', async () => {
    await add(ALICE, oid(1), 1); await add(ALICE, oid(2), 2); await add(ALICE, oid(3), 3);
    catalogFx.fixture.calls.length = 0;
    const r = await json(call('GET', '/', { headers: { ...ALICE, 'X-Request-Id': 'trace-cart-1' } }));
    assert.equal(r.body.itemCount, 3);
    assert.equal(catalogFx.fixture.calls.length, 1, 'exactly one catalog call');
    assert.deepEqual([...catalogFx.fixture.calls[0].productIds].sort(), [oid(1), oid(2), oid(3)]);
    assert.equal(catalogFx.fixture.calls[0].requestId, 'trace-cart-1');
    assert.equal(r.headers.get('x-request-id'), 'trace-cart-1');
  });

  test('money: integer paise, exact line and cart totals, currency stated', async () => {
    await add(ALICE, oid(1), 3); await add(ALICE, oid(2), 2);
    const r = await get(ALICE);
    const l1 = r.body.items.find((i) => i.productId === oid(1));
    assert.equal(l1.unitPriceInPaise, 499900);
    assert.equal(l1.lineTotalInPaise, 1499700);
    assert.equal(r.body.totalInPaise, 1499700 + 79800);
    assert.equal(r.body.currency, 'INR');
    assert.equal(r.body.pricing.status, 'complete');
    assert.equal(r.body.degraded, false);
    assert.ok(Number.isInteger(r.body.totalInPaise));
  });

  test('a price change in Catalog shows on the next read with no cart write or cache flush', async () => {
    await add(ALICE, oid(1), 2);
    assert.equal((await get(ALICE)).body.totalInPaise, 999800);
    catalogFx.fixture.products.get(oid(1)).priceInPaise = 450000;
    try {
      const r = await get(ALICE);
      assert.equal(r.headers.get('x-cache'), 'HIT', 'served from cache — contents unchanged');
      assert.equal(r.body.items[0].unitPriceInPaise, 450000);
      assert.equal(r.body.totalInPaise, 900000);
    } finally {
      catalogFx.fixture.products.get(oid(1)).priceInPaise = 499900;
    }
  });

  test('an item Catalog reports not_found / inactive is flagged per line, not dropped; no total', async () => {
    await add(ALICE, oid(1), 1); await add(ALICE, oid(2), 1);
    // Product 2 gets delisted after it was added.
    catalogFx.fixture.products.get(oid(2)).isActive = false;
    await Cart.updateOne({ userId: 'user_alice' }, { $push: { items: { productId: NIL, quantity: 1 } } });
    await cache._client.del(redisKey('user_alice'));
    try {
      const r = await get(ALICE);
      const by = Object.fromEntries(r.body.items.map((i) => [i.productId, i.priceStatus]));
      assert.deepEqual(by, { [oid(1)]: 'ok', [oid(2)]: 'inactive', [NIL]: 'not_found' });
      assert.equal(r.body.pricing.status, 'partial');
      assert.equal(r.body.totalInPaise, null, 'no total from missing prices');
      assert.equal(r.body.degraded, false, 'catalog was reachable; this is a data condition');
    } finally {
      catalogFx.fixture.products.get(oid(2)).isActive = true;
    }
  });

  test('adding a not_found / inactive product is rejected; catalog down on add → 503', async () => {
    let r = await add(ALICE, NIL, 1);
    assert.equal(r.status, 404); assert.equal(r.body.error, 'product_not_found');
    r = await add(ALICE, oid(4), 1);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'product_unavailable');
    catalogFx.fixture.mode = 'error';
    r = await add(ALICE, oid(1), 1);
    assert.equal(r.status, 503); assert.equal(r.body.error, 'catalog_unavailable');
    assert.equal(await Cart.countDocuments({ userId: 'user_alice' }), 0, 'nothing stored');
  });
});

// ---------------------------------------------------------------------------
describe('circuit breaker (timeout 300ms, opens at 50% of >=3 calls, resets after 600ms)', () => {
  test('closed → open (fast fail, degraded cart) → half-open → closed', async () => {
    await add(ALICE, oid(1), 2);
    const fresh = await bootApp(); // own breaker, clean stats
    const g = () => json(fetch(`${fresh.base}/`, { headers: ALICE }));
    const timed = async () => { const t = performance.now(); const r = await g(); return { r, ms: performance.now() - t }; };
    try {
      catalogFx.fixture.mode = 'hang';
      const slow = [];
      for (let i = 0; i < 3; i++) slow.push(await timed());
      for (const { r, ms } of slow) {
        assert.equal(r.status, 200, 'cart still returned');
        assert.equal(r.body.degraded, true);
        assert.equal(r.body.pricing.status, 'unavailable');
        assert.equal(r.body.totalInPaise, null);
        assert.equal(r.body.items[0].priceStatus, 'unavailable');
        assert.equal(r.body.items[0].quantity, 2, 'quantities intact');
        assert.ok(ms >= 280, `timed out after ${ms.toFixed(0)}ms`);
      }
      assert.equal(fresh.catalog.describe().state, 'open', 'breaker opened after the threshold');

      const callsBefore = catalogFx.fixture.calls.length;
      const fast = await timed();
      assert.equal(fast.r.body.pricing.reason, 'catalog_breaker_open');
      assert.ok(fast.ms < 100, `open breaker fails fast: ${fast.ms.toFixed(1)}ms`);
      assert.equal(catalogFx.fixture.calls.length, callsBefore, 'no network call while open');

      catalogFx.fixture.mode = 'ok';
      await delay(700); // > resetTimeout
      assert.equal(fresh.catalog.describe().state, 'half-open');
      const trial = await g();
      assert.equal(trial.body.degraded, false);
      assert.equal(trial.body.totalInPaise, 999800);
      assert.equal(fresh.catalog.describe().state, 'closed', 'trial succeeded → closed');
    } finally {
      catalogFx.fixture.mode = 'ok';
      fresh.server.closeAllConnections(); fresh.server.close(); await fresh.cache.stop(); fresh.catalog.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('/snapshot (strict, for checkout)', () => {
  test('returns fully priced lines and total when Catalog is up; bypasses the cache', async () => {
    await add(ALICE, oid(1), 2); await add(ALICE, oid(3), 1);
    // Mutate Mongo behind the cache: snapshot must see MongoDB, not Redis.
    await Cart.updateOne({ userId: 'user_alice', 'items.productId': oid(3) }, { $set: { 'items.$.quantity': 5 } });
    const r = await get(ALICE, '/snapshot');
    assert.equal(r.status, 200);
    assert.equal(r.body.items.find((i) => i.productId === oid(3)).quantity, 5, 'read from MongoDB');
    assert.deepEqual(Object.keys(r.body.items[0]).sort(), ['currency', 'lineTotalInPaise', 'name', 'productId', 'quantity', 'sku', 'unitPriceInPaise']);
    assert.equal(r.body.totalInPaise, 499900 * 2 + 119900 * 5);
    assert.equal(r.body.currency, 'INR');
    assert.ok(r.body.pricedAt && r.body.snapshotAt);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('fails: empty cart → 409; item unavailable → 409 with details; catalog down → 503 (GET / degrades instead)', async () => {
    let r = await get(ALICE, '/snapshot');
    assert.equal(r.status, 409); assert.equal(r.body.error, 'cart_empty');

    await add(ALICE, oid(1), 1); await add(ALICE, oid(2), 1);
    catalogFx.fixture.products.get(oid(2)).isActive = false;
    try {
      r = await get(ALICE, '/snapshot');
      assert.equal(r.status, 409); assert.equal(r.body.error, 'cart_has_unavailable_items');
      assert.deepEqual(r.body.details, [{ field: `items.${oid(2)}`, message: 'inactive' }]);
    } finally { catalogFx.fixture.products.get(oid(2)).isActive = true; }

    catalogFx.fixture.mode = 'error';
    r = await get(ALICE, '/snapshot');
    assert.equal(r.status, 503); assert.equal(r.body.error, 'pricing_unavailable');
    const soft = await get(ALICE);
    assert.equal(soft.status, 200); assert.equal(soft.body.degraded, true);
  });
});

// ---------------------------------------------------------------------------
describe('isolation & validation', () => {
  test('a user can only ever see or change their own cart', async () => {
    await add(ALICE, oid(1), 2);
    assert.deepEqual((await get(BOB)).body.items, []);
    const smuggle = await json(call('POST', '/items', { headers: BOB, body: { productId: oid(1), quantity: 1, userId: 'user_alice' } }));
    assert.equal(smuggle.status, 400);
    assert.match(smuggle.body.message, /Unrecognized key: "userId"/);
    assert.equal((await get(BOB, '/?userId=user_alice')).body.userId, 'user_bob');
    assert.equal((await call('DELETE', `/items/${oid(1)}`, { headers: BOB })).status, 404);
    assert.equal((await call('DELETE', '/', { headers: BOB })).status, 204);
    assert.equal((await get(ALICE)).body.itemCount, 1, "alice's cart untouched");
  });

  test('quantity 0 / negative / float / string / above max / bad id → 400 with field details', async () => {
    for (const [body, msg] of [
      [{ productId: oid(1), quantity: 0 }, /at least 1/], [{ productId: oid(1), quantity: -1 }, /at least 1/],
      [{ productId: oid(1), quantity: 1.5 }, /whole number/], [{ productId: oid(1), quantity: '2' }, /must be a number/],
      [{ productId: oid(1), quantity: 11 }, /at most 10/], [{ productId: 'nope', quantity: 1 }, /24-character/],
    ]) {
      const r = await json(call('POST', '/items', { headers: ALICE, body }));
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'validation_error');
      assert.match(r.body.details[0].message, msg);
    }
  });

  test('per-item maximum across merges and the line-item cap', async () => {
    await add(ALICE, oid(1), 6);
    let r = await add(ALICE, oid(1), 5);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'quantity_limit_exceeded');
    await add(ALICE, oid(2), 1); await add(ALICE, oid(3), 1); // 3 lines = CART_MAX_LINE_ITEMS
    catalogFx.fixture.products.set(oid(5), { name: 'Extra', sku: 'X-5', priceInPaise: 100, currency: 'INR', isActive: true });
    r = await add(ALICE, oid(5), 1);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'cart_full');
    assert.equal((await get(ALICE)).body.itemCount, 3);
  });
});

// ---------------------------------------------------------------------------
describe('configuration & shutdown', () => {
  test('ownership guard and missing variables are reported together', () => {
    assert.throws(() => loadConfig(testEnv({ CART_MONGO_URI: 'mongodb://localhost:27017/catalog_db', REDIS_PASSWORD: '', CART_BREAKER_ERROR_THRESHOLD_PERCENT: '150' })), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /CART_MONGO_URI points at database "catalog_db" but this service owns "cart_test_db"/);
      assert.match(err.message, /REDIS_PASSWORD is required/);
      assert.match(err.message, /CART_BREAKER_ERROR_THRESHOLD_PERCENT must be between 1 and 100/);
      return true;
    });
  });

  test('graceful shutdown finishes in-flight work then refuses connections', async () => {
    await add(ALICE, oid(1), 1);
    const inst = await bootApp();
    catalogFx.fixture.mode = 'hang'; // the read below stays in flight for ~300ms (catalog timeout)
    const inFlight = fetch(`${inst.base}/`, { headers: ALICE });
    await delay(50);
    const code = inst.shutdown('test');
    const res = await inFlight;
    assert.equal(res.status, 200, 'in-flight request completed');
    assert.equal((await res.json()).degraded, true);
    assert.equal(await code, 0);
    await assert.rejects(fetch(`${inst.base}/health`));
    catalogFx.fixture.mode = 'ok';
    await inst.cache.stop(); inst.catalog.stop();
  });
});
