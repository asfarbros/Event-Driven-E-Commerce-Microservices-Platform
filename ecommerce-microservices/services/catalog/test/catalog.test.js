/**
 * Integration tests against a real MongoDB (catalog_test_db). Run `npm test`
 * with the Step 0 infrastructure up. Each suite starts from an empty
 * collection and seeds what it needs.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { loadConfig, ConfigError } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { createApp } from '../src/app.js';
import { startServer } from '../src/server.js';
import { createMongoConnector } from '../src/db/mongo.js';
import { Product } from '../src/models/product.js';
import { SEED_PRODUCTS } from '../scripts/seed.js';
import { testEnv, TEST_DB } from './helpers/test-env.js';

const logger = createLogger({ level: 'silent' });
const config = loadConfig(testEnv());
const NIL_ID = '000000000000000000000000';

let base, server, shutdown, mongo;

const json = async (res) => ({ status: res.status, headers: res.headers, body: await res.json() });
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  mongo = createMongoConnector(config.mongo, logger);
  assert.equal(await mongo.connectWithRetry(), true, `MongoDB must be reachable for tests (${TEST_DB})`);
  assert.equal(mongoose.connection.name, TEST_DB, 'tests must run against the test database');
  await mongoose.connection.dropDatabase();
  await Product.syncIndexes();

  const app = createApp(config, logger, { version: 'test' });
  const started = startServer(app, { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 2000 }, logger);
  server = started.server;
  shutdown = started.shutdown;
  const { port } = await started.listening;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await mongoose.connection.dropDatabase();
  await mongo.stop();
});

async function seed() {
  await Product.deleteMany({});
  await Product.insertMany(SEED_PRODUCTS);
}

// ---------------------------------------------------------------------------
describe('health', () => {
  test('GET /health is 200 and reports the connected database', async () => {
    const r = await json(await fetch(`${base}/health`));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.service, 'catalog');
    assert.equal(r.body.db.state, 'connected');
    assert.equal(r.body.db.database, TEST_DB);
    assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });

  test('GET /ready is 200 while connected', async () => {
    assert.equal((await fetch(`${base}/ready`)).status, 200);
  });
});

// ---------------------------------------------------------------------------
describe('listing', () => {
  before(seed);

  test('paginates with metadata and applies the default limit', async () => {
    const r = await json(await fetch(`${base}/products`));
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 5); // CATALOG_PAGE_LIMIT_DEFAULT
    assert.deepEqual(r.body.pagination, { page: 1, limit: 5, total: SEED_PRODUCTS.length, totalPages: 3, hasNext: true, hasPrev: false });
    assert.equal(r.body.sort, 'newest');
    const item = r.body.items[0];
    assert.equal(typeof item.priceInPaise, 'number');
    assert.ok(Number.isInteger(item.priceInPaise), 'money is an integer');
    assert.equal(item.currency, 'INR');
    assert.equal(item.description, undefined, 'listing omits the long description');
  });

  test('page 3 of 5 is the last page', async () => {
    const r = await json(await fetch(`${base}/products?page=3&limit=5`));
    assert.equal(r.body.items.length, 4);
    assert.equal(r.body.pagination.hasNext, false);
    assert.equal(r.body.pagination.hasPrev, true);
  });

  test('limit above the maximum is capped, not rejected', async () => {
    const r = await json(await fetch(`${base}/products?limit=99999`));
    assert.equal(r.status, 200);
    assert.equal(r.body.pagination.limit, 10); // CATALOG_PAGE_LIMIT_MAX
    assert.equal(r.body.items.length, 10);
  });

  test('filters by category', async () => {
    const r = await json(await fetch(`${base}/products?category=books`));
    const expected = SEED_PRODUCTS.filter((p) => p.category === 'books').length;
    assert.equal(r.body.pagination.total, expected);
    assert.ok(r.body.items.every((i) => i.category === 'books'));
  });

  test('sorts by price ascending / descending within a category', async () => {
    const asc = await json(await fetch(`${base}/products?category=electronics&sort=price_asc`));
    const prices = asc.body.items.map((i) => i.priceInPaise);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
    const desc = await json(await fetch(`${base}/products?category=electronics&sort=price_desc`));
    assert.deepEqual(desc.body.items.map((i) => i.priceInPaise), [...prices].reverse());
  });

  test('text search matches name and description, ranked by relevance', async () => {
    const r = await json(await fetch(`${base}/products?q=headphones`));
    assert.equal(r.body.sort, 'relevance');
    assert.equal(r.body.items[0].sku, 'ELC-NB-ANC-01');
    const desc = await json(await fetch(`${base}/products?q=stainless`));
    assert.ok(desc.body.pagination.total >= 2, 'matches descriptions too');
  });

  test('search combined with a category filter', async () => {
    const r = await json(await fetch(`${base}/products?q=kettle&category=electronics`));
    assert.equal(r.body.pagination.total, 0);
    const ok = await json(await fetch(`${base}/products?q=kettle&category=home-kitchen`));
    assert.equal(ok.body.pagination.total, 1);
  });

  test('sort=relevance without q is a 400', async () => {
    const r = await json(await fetch(`${base}/products?sort=relevance`));
    assert.equal(r.status, 400);
  });

  test('hides inactive products by default; includeInactive=true shows them', async () => {
    const victim = await Product.findOne({ sku: 'SP-YOGA-MAT-6' });
    await Product.updateOne({ _id: victim._id }, { $set: { isActive: false } });
    const hidden = await json(await fetch(`${base}/products?category=sports&limit=10`));
    assert.ok(!hidden.body.items.some((i) => i.sku === 'SP-YOGA-MAT-6'));
    const shown = await json(await fetch(`${base}/products?category=sports&includeInactive=true&limit=10`));
    assert.ok(shown.body.items.some((i) => i.sku === 'SP-YOGA-MAT-6' && i.isActive === false));
  });

  test('bad query input → 400 with field-level details', async () => {
    const r = await json(await fetch(`${base}/products?page=0&limit=abc&sort=sideways&category=Bad_Cat`));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'validation_error');
    const fields = r.body.details.map((d) => d.field).sort();
    assert.deepEqual(fields, ['query.category', 'query.limit', 'query.page', 'query.sort']);
    assert.equal(typeof r.body.requestId, 'string');
  });

  test('operator injection in query params cannot reach the filter', async () => {
    // Express 5's simple query parser + zod: the key is unknown and dropped.
    const r = await json(await fetch(`${base}/products?category[$ne]=x&limit=10`));
    assert.equal(r.status, 200);
    assert.equal(r.body.pagination.total, SEED_PRODUCTS.length - 1); // minus the deactivated one above
  });
});

// ---------------------------------------------------------------------------
describe('single product', () => {
  before(seed);

  test('returns an active product by id', async () => {
    const doc = await Product.findOne({ sku: 'BK-TEC-DDIA-01' });
    const r = await json(await fetch(`${base}/products/${doc._id}`));
    assert.equal(r.status, 200);
    assert.equal(r.body.id, String(doc._id));
    assert.equal(r.body.priceInPaise, 285000);
    assert.equal(r.body.currency, 'INR');
    assert.ok(r.body.description.length > 0);
  });

  test('unknown id → 404; malformed id → 400', async () => {
    const missing = await json(await fetch(`${base}/products/${NIL_ID}`));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'product_not_found');
    const bad = await json(await fetch(`${base}/products/not-an-id`));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'validation_error');
  });

  test('soft-deleted product → 404', async () => {
    const doc = await Product.findOne({ sku: 'SP-BOT-STL-1L' });
    await Product.updateOne({ _id: doc._id }, { $set: { isActive: false } });
    assert.equal((await fetch(`${base}/products/${doc._id}`)).status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('bulk price lookup (the Cart/Order contract)', () => {
  let active, inactive;
  before(async () => {
    await seed();
    active = await Product.find({ category: 'electronics' }).limit(3);
    inactive = await Product.findOne({ sku: 'HK-SPC-RACK-12' });
    await Product.updateOne({ _id: inactive._id }, { $set: { isActive: false } });
  });

  test('returns prices for active ids and names every problem id', async () => {
    const ids = [...active.map((d) => String(d._id)), NIL_ID, String(inactive._id), String(active[0]._id)];
    const r = await json(await post(`${base}/products/prices`, { productIds: ids }));
    assert.equal(r.status, 200);
    assert.equal(r.body.prices.length, 3, 'duplicates are collapsed');
    for (const p of r.body.prices) {
      const doc = active.find((d) => String(d._id) === p.productId);
      assert.deepEqual(p, { productId: p.productId, sku: doc.sku, name: doc.name, priceInPaise: doc.priceInPaise, currency: 'INR' });
      assert.ok(Number.isInteger(p.priceInPaise));
    }
    assert.deepEqual(r.body.unavailable, [
      { productId: NIL_ID, reason: 'not_found' },
      { productId: String(inactive._id), reason: 'inactive' },
    ]);
    assert.ok(Date.parse(r.body.asOf) > 0);
    const covered = new Set([...r.body.prices.map((p) => p.productId), ...r.body.unavailable.map((u) => u.productId)]);
    assert.equal(covered.size, new Set(ids).size, 'every requested id is accounted for exactly once');
  });

  test('issues exactly ONE MongoDB query regardless of id count', async () => {
    const ids = [...active.map((d) => String(d._id)), ...Array.from({ length: 40 }, (_, i) => String(i).padStart(24, '0'))];
    const ops = [];
    mongoose.set('debug', (coll, method) => ops.push(`${coll}.${method}`));
    try {
      const r = await json(await post(`${base}/products/prices`, { productIds: ids }));
      assert.equal(r.status, 200);
      assert.equal(r.body.prices.length + r.body.unavailable.length, ids.length);
    } finally {
      mongoose.set('debug', false);
    }
    assert.deepEqual(ops, ['products.find']);
  });

  test('rejects an empty list, malformed ids, and more than the maximum', async () => {
    assert.equal((await post(`${base}/products/prices`, { productIds: [] })).status, 400);
    const bad = await json(await post(`${base}/products/prices`, { productIds: [NIL_ID, 'nope'] }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.details[0].field, 'body.productIds.1');
    const tooMany = await post(`${base}/products/prices`, { productIds: Array(51).fill(NIL_ID) });
    assert.equal(tooMany.status, 400);
  });
});

// ---------------------------------------------------------------------------
describe('admin writes', () => {
  before(seed);
  const valid = { name: 'Test Lamp', description: 'A lamp.', priceInPaise: 149900, category: 'home-kitchen', sku: 'HK-LAMP-001', imageUrl: 'https://example.com/lamp.jpg' };

  test('creates a product (201, Location header, default currency)', async () => {
    const r = await json(await post(`${base}/products`, valid, { 'X-User-Id': 'user_admin' }));
    assert.equal(r.status, 201);
    assert.match(r.headers.get('location'), /^\/products\/[0-9a-f]{24}$/);
    assert.equal(r.body.currency, 'INR');
    assert.equal(r.body.isActive, true);
    assert.equal(r.body.sku, 'HK-LAMP-001');
  });

  test('duplicate sku → 409, not 500', async () => {
    const r = await json(await post(`${base}/products`, { ...valid, name: 'Another' }));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'duplicate_sku');
    assert.doesNotMatch(r.body.message, /E11000|index|collection/);
  });

  test('sku is case-insensitive unique (normalised to upper case)', async () => {
    const r = await json(await post(`${base}/products`, { ...valid, sku: 'hk-lamp-001' }));
    assert.equal(r.status, 409);
  });

  test('missing field, negative price, float price, unknown field, bad JSON → 400', async () => {
    const { priceInPaise, ...noPrice } = valid;
    const cases = [
      [{ ...noPrice, sku: 'X-1' }, 'body.priceInPaise'],
      [{ ...valid, sku: 'X-2', priceInPaise: -1 }, 'body.priceInPaise'],
      [{ ...valid, sku: 'X-3', priceInPaise: 10.5 }, 'body.priceInPaise'],
      [{ ...valid, sku: 'X-4', price: 100 }, 'body'],
      [{ ...valid, sku: 'X-5', imageUrl: 'ftp://nope' }, 'body.imageUrl'],
    ];
    for (const [body, field] of cases) {
      const r = await json(await post(`${base}/products`, body));
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.details.some((d) => d.field === field), `${field} in ${JSON.stringify(r.body.details)}`);
    }
    const raw = await fetch(`${base}/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(raw.status, 400);
    assert.equal((await raw.json()).error, 'invalid_json');
  });

  test('updates a product; empty body → 400; unknown id → 404', async () => {
    const doc = await Product.findOne({ sku: 'HK-LAMP-001' });
    const r = await json(await fetch(`${base}/products/${doc._id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priceInPaise: 129900 }) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.priceInPaise, 129900);
    const empty = await json(await fetch(`${base}/products/${doc._id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    assert.equal(empty.status, 400, 'PUT {} must not apply creation defaults');
    assert.equal((await Product.findById(doc._id).lean()).isActive, true);
    assert.equal((await fetch(`${base}/products/${NIL_ID}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })).status, 404);
  });

  test('DELETE soft-deletes: hidden from reads and prices, document remains', async () => {
    const doc = await Product.findOne({ sku: 'HK-LAMP-001' });
    const r = await json(await fetch(`${base}/products/${doc._id}`, { method: 'DELETE' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.isActive, false);

    assert.equal((await fetch(`${base}/products/${doc._id}`)).status, 404);
    const list = await json(await fetch(`${base}/products?category=home-kitchen&limit=10`));
    assert.ok(!list.body.items.some((i) => i.id === String(doc._id)));
    const prices = await json(await post(`${base}/products/prices`, { productIds: [String(doc._id)] }));
    assert.deepEqual(prices.body.unavailable, [{ productId: String(doc._id), reason: 'inactive' }]);

    const stillThere = await Product.findById(doc._id).lean();
    assert.ok(stillThere, 'document still exists');
    assert.equal(stillThere.isActive, false);
    assert.equal(stillThere.priceInPaise, 129900, 'price history preserved');

    assert.equal((await fetch(`${base}/products/${doc._id}`, { method: 'DELETE' })).status, 404, 'second delete is a 404');
  });
});

// ---------------------------------------------------------------------------
describe('correlation and identity headers', () => {
  test('reuses X-Request-Id and echoes it; ignores malformed ones', async () => {
    const r = await fetch(`${base}/health`, { headers: { 'X-Request-Id': 'gw-trace-1' } });
    assert.equal(r.headers.get('x-request-id'), 'gw-trace-1');
    const bad = await fetch(`${base}/health`, { headers: { 'X-Request-Id': 'bad id!' } });
    assert.match(bad.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });

  test('works with and without X-User-Id (no auth here)', async () => {
    assert.equal((await fetch(`${base}/products?limit=1`)).status, 200);
    assert.equal((await fetch(`${base}/products?limit=1`, { headers: { 'X-User-Id': 'user_123' } })).status, 200);
  });

  test('unknown route → 404 JSON', async () => {
    const r = await json(await fetch(`${base}/nope`));
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  });
});

// ---------------------------------------------------------------------------
describe('configuration validation', () => {
  test('lists every problem at once, including the database-ownership guard', () => {
    const env = testEnv({ CATALOG_MONGO_URI: 'mongodb://localhost:27017/orders_db', CATALOG_PAGE_LIMIT_MAX: '1', CATALOG_DEFAULT_CURRENCY: 'rupees', CATALOG_PORT: '' });
    assert.throws(() => loadConfig(env), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /CATALOG_MONGO_URI points at database "orders_db" but this service owns "catalog_test_db"/);
      assert.match(err.message, /CATALOG_PAGE_LIMIT_DEFAULT \(5\) must not exceed CATALOG_PAGE_LIMIT_MAX \(1\)/);
      assert.match(err.message, /CATALOG_DEFAULT_CURRENCY must be a 3-letter/);
      assert.match(err.message, /CATALOG_PORT is required/);
      return true;
    });
  });

  test('the real process exits 1 naming the missing variable', async () => {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
    const env = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/nonexistent/.env', ...testEnv() };
    delete env.CATALOG_MONGO_URI;
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [entry], { env, windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing to start/);
    assert.match(result.stderr, /CATALOG_MONGO_URI is required/);
  });
});

// ---------------------------------------------------------------------------
describe('graceful shutdown', () => {
  test('in-flight request finishes, then the server refuses new connections', async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    // A request whose body is still being uploaded when shutdown starts.
    const body = JSON.stringify({ productIds: [NIL_ID] });
    const req = http.request(`${base}/products/prices`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    const response = new Promise((resolve, reject) => {
      req.on('response', (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) })); });
      req.on('error', reject);
    });
    req.write(body.slice(0, 10));
    await delay(50);

    const code = shutdown('test');          // server stops listening now
    await delay(50);
    req.end(body.slice(10));                // …but the in-flight request still completes

    const res = await response;
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.unavailable, [{ productId: NIL_ID, reason: 'not_found' }]);
    assert.equal(await code, 0, 'closed within the grace period');
    await assert.rejects(fetch(`${base}/health`), 'no longer accepting connections');
  });
});
