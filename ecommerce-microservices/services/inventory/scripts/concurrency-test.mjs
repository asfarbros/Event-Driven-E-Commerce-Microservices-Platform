#!/usr/bin/env node
/**
 * Concurrency proof for the Inventory Service. Zero dependencies (Node 18+).
 * Run against a RUNNING service (reads INVENTORY_SERVICE_URL from ../../.env,
 * or pass --url).
 *
 *   node scripts/concurrency-test.mjs single   --units 1 --requests 50
 *       Sets a product to exactly `units` available, then fires `requests`
 *       SIMULTANEOUS reserve calls (distinct orderIds, quantity 1). Exactly
 *       `units` must succeed (201); every other call must get 409; the final
 *       stock must be available=0, reserved=units.
 *
 *   node scripts/concurrency-test.mjs deadlock --requests 40
 *       Fires `requests` concurrent TWO-item reserves, half listing the
 *       products as [A, B] and half as [B, A] — the classic deadlock shape.
 *       Every call must succeed (no 5xx, no 503 stock_lock_timeout, no
 *       PostgreSQL deadlock) and each product's available must drop by
 *       exactly `requests`.
 *
 *   node scripts/concurrency-test.mjs idempotent --requests 30
 *       Fires `requests` simultaneous reserves with the SAME orderId. Exactly
 *       one may create (201); the rest must replay it (200, created=false);
 *       stock must move by ONE order's quantity only.
 *
 * Test products are created/reset through POST /stock/{id}/adjust, so the
 * seeded catalogue rows are never touched. Exit code 1 on any violation.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const mode = args[0] ?? 'single';
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};

function loadEnv() {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
    const env = {};
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    return env;
  } catch {
    return {};
  }
}

const env = loadEnv();
const BASE = (opt('url', process.env.INVENTORY_SERVICE_URL ?? env.INVENTORY_SERVICE_URL ?? 'http://localhost:8082')).replace(/\/+$/, '');
const REQUESTS = Number(opt('requests', mode === 'deadlock' ? 40 : 50));
const UNITS = Number(opt('units', 1));
const runTag = randomUUID().slice(0, 8);

async function call(method, route, body, headers = {}) {
  const started = performance.now();
  const res = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json, ms: Math.round(performance.now() - started) };
}

const setStock = (productId, units) => call('POST', `/stock/${productId}/adjust`, { operation: 'SET', quantity: units });
const stock = async (productId) => (await call('GET', `/stock/${productId}`)).body;

function summarise(results) {
  const byStatus = {};
  for (const r of results) {
    const key = `${r.status} ${r.body?.error ?? (r.body?.created === false ? 'replay' : r.body?.status ?? '')}`.trim();
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  return { byStatus, minMs: times[0], p50Ms: times[Math.floor(times.length / 2)], maxMs: times[times.length - 1] };
}

function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); return true; }
  console.log(`  FAIL  ${message}`);
  process.exitCode = 1;
  return false;
}

async function single() {
  const productId = `ctest-single-${runTag}`;
  console.log(`\n== SINGLE PRODUCT: ${UNITS} unit(s), ${REQUESTS} simultaneous reserves (product ${productId})`);
  await setStock(productId, UNITS);
  console.log('  before:', await stock(productId));

  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: REQUESTS }, (_, i) =>
      call('POST', '/reserve', { orderId: `ord-${runTag}-${i}`, items: [{ productId, quantity: 1 }] },
        { 'X-Request-Id': `ctest-${runTag}-${i}` })),
  );
  const wall = Math.round(performance.now() - t0);
  const s = summarise(results);
  const created = results.filter((r) => r.status === 201).length;
  const conflicts = results.filter((r) => r.status === 409 && r.body.error === 'insufficient_stock').length;
  const others = results.filter((r) => r.status !== 201 && r.status !== 409);
  console.log(`  responses: ${JSON.stringify(s.byStatus)}  wall=${wall}ms  latency min/p50/max=${s.minMs}/${s.p50Ms}/${s.maxMs}ms`);
  if (others.length) console.log('  unexpected:', others.slice(0, 3).map((r) => `${r.status} ${JSON.stringify(r.body)}`));
  const after = await stock(productId);
  console.log('  after: ', after);

  assert(created === UNITS, `exactly ${UNITS} succeeded (got ${created})`);
  assert(conflicts === REQUESTS - UNITS, `exactly ${REQUESTS - UNITS} got 409 insufficient_stock (got ${conflicts})`);
  assert(others.length === 0, `no other outcomes (got ${others.length})`);
  assert(after.available === 0 && after.reserved === UNITS, `final stock available=0 reserved=${UNITS} (got ${after.available}/${after.reserved})`);
  return { productId, created };
}

async function deadlock() {
  const a = `ctest-dl-A-${runTag}`;
  const b = `ctest-dl-B-${runTag}`;
  const plenty = REQUESTS * 2 + 100;
  console.log(`\n== DEADLOCK: ${REQUESTS} concurrent two-item reserves, half [A,B] and half [B,A] (A=${a}, B=${b})`);
  await setStock(a, plenty);
  await setStock(b, plenty);
  console.log('  before:', await stock(a), await stock(b));

  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: REQUESTS }, (_, i) => {
      const items = i % 2 === 0
        ? [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }]
        : [{ productId: b, quantity: 1 }, { productId: a, quantity: 1 }];
      return call('POST', '/reserve', { orderId: `ord-dl-${runTag}-${i}`, items });
    }),
  );
  const wall = Math.round(performance.now() - t0);
  const s = summarise(results);
  const ok = results.filter((r) => r.status === 201).length;
  const failures = results.filter((r) => r.status !== 201);
  console.log(`  responses: ${JSON.stringify(s.byStatus)}  wall=${wall}ms  latency min/p50/max=${s.minMs}/${s.p50Ms}/${s.maxMs}ms`);
  if (failures.length) console.log('  failures:', failures.slice(0, 3).map((r) => `${r.status} ${JSON.stringify(r.body)}`));
  const [afterA, afterB] = [await stock(a), await stock(b)];
  console.log('  after: ', afterA, afterB);

  assert(ok === REQUESTS, `all ${REQUESTS} succeeded — no deadlock, no lock timeout (got ${ok})`);
  assert(afterA.available === plenty - REQUESTS && afterA.reserved === REQUESTS, `A moved by exactly ${REQUESTS} (available ${afterA.available}, reserved ${afterA.reserved})`);
  assert(afterB.available === plenty - REQUESTS && afterB.reserved === REQUESTS, `B moved by exactly ${REQUESTS} (available ${afterB.available}, reserved ${afterB.reserved})`);
}

async function idempotent() {
  const productId = `ctest-idem-${runTag}`;
  const orderId = `ord-idem-${runTag}`;
  console.log(`\n== IDEMPOTENT: ${REQUESTS} simultaneous reserves with the SAME orderId ${orderId}`);
  await setStock(productId, 100);
  const results = await Promise.all(
    Array.from({ length: REQUESTS }, () => call('POST', '/reserve', { orderId, items: [{ productId, quantity: 2 }] })),
  );
  const s = summarise(results);
  const created = results.filter((r) => r.status === 201).length;
  const replayed = results.filter((r) => r.status === 200 && r.body.created === false).length;
  const ids = new Set(results.map((r) => r.body.reservationId));
  console.log(`  responses: ${JSON.stringify(s.byStatus)}`);
  const after = await stock(productId);
  console.log('  after: ', after);
  assert(created === 1, `exactly one 201 created (got ${created})`);
  assert(replayed === REQUESTS - 1, `${REQUESTS - 1} replays with created=false (got ${replayed})`);
  assert(ids.size === 1, `every response carries the same reservationId (got ${ids.size} distinct)`);
  assert(after.available === 98 && after.reserved === 2, `stock moved by ONE order only (available ${after.available}, reserved ${after.reserved})`);
}

const modes = { single, deadlock, idempotent };
if (!modes[mode]) {
  console.error(`unknown mode "${mode}" — use single | deadlock | idempotent`);
  process.exit(2);
}
console.log(`target ${BASE}`);
await modes[mode]();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS');
