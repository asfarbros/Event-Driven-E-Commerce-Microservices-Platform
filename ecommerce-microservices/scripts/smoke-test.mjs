#!/usr/bin/env node
/**
 * OrderFlow smoke test — the happy path, end to end, through the API Gateway,
 * exactly as a browser would do it (plus the payment webhook a real Razorpay
 * would send). Pass/fail in one command:
 *
 *   ./orderflow.sh smoke            (or: node scripts/smoke-test.mjs)
 *
 * Steps (each timed, each a check):
 *   1. gateway /health is ok
 *   2. mint a Clerk session token for SMOKE_CLERK_USER_ID (Backend API, CLERK_SECRET_KEY)
 *   3. browse: GET /api/catalog/products (public)
 *   4. stock before: GET /api/inventory/stock/{productId}
 *   5. cart: DELETE /api/cart/ then POST /api/cart/items
 *   6. checkout: POST /api/orders/ → 201 AWAITING_PAYMENT (Idempotency-Key, X-Request-Id)
 *   7. stock reserved: available -1, reserved +1
 *   8. payment success: signed webhook → POST /api/payment-webhooks/razorpay (public route, HMAC)
 *   9. order reaches CONFIRMED (poll /status)
 *  10. stock deducted permanently: reserved back, available stays -1
 *  11. payment record SUCCESS: GET /api/payments/payments/{orderId}
 *  12. notification sent (docker logs of the worker, if docker is available)
 *
 * Zero dependencies (Node ≥ 20). Reads the root .env; never prints secrets.
 * Exit code 0 = all checks passed, 1 = a check failed, 2 = configuration.
 */
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const cfg = (k) => process.env[k] ?? env[k];
for (const k of ['GATEWAY_PORT', 'CLERK_SECRET_KEY', 'RAZORPAY_WEBHOOK_SECRET', 'SMOKE_CLERK_USER_ID']) {
  if (!cfg(k)) { console.error(`config: ${k} is missing in .env`); process.exit(2); }
}
const GATEWAY = process.env.SMOKE_GATEWAY_URL || `http://localhost:${cfg('GATEWAY_PORT')}`;
const REQUEST_ID = `smoke-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
const TIMEOUT_S = Number(process.env.SMOKE_CONFIRM_TIMEOUT_S || 45);

const results = [];
let jwt = null;
const startedAt = Date.now();

async function step(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}  (${Math.round(performance.now() - t0)} ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Math.round(performance.now() - t0), detail: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
    throw err;
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

async function gw(method, p, body, extra = {}) {
  const res = await fetch(`${GATEWAY}${p}`, {
    method, headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), 'Content-Type': 'application/json', 'X-Request-Id': REQUEST_ID, ...extra },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

let product; let before; let order;
try {
  console.log(`OrderFlow smoke test  gateway=${GATEWAY}  requestId=${REQUEST_ID}`);

  await step('gateway healthy', async () => {
    const r = await gw('GET', '/health');
    expect(r.status === 200 && r.json.status === 'ok', `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    return `version ${r.json.version}`;
  });

  await step('clerk token minted', async () => {
    const h = { Authorization: `Bearer ${cfg('CLERK_SECRET_KEY')}`, 'Content-Type': 'application/json' };
    const post = async (url, body) => { for (let attempt = 1; ; attempt += 1) { try { return await fetch(url, { method: 'POST', headers: h, body }); } catch (e) { if (attempt >= 4 || e.cause?.code !== 'ECONNRESET') throw e; await new Promise((r) => setTimeout(r, 300 * attempt)); } } };
    const s = await post('https://api.clerk.com/v1/sessions', JSON.stringify({ user_id: cfg('SMOKE_CLERK_USER_ID') }));
    expect(s.ok, `clerk sessions → HTTP ${s.status}`);
    const session = await s.json();
    const t = await post(`https://api.clerk.com/v1/sessions/${session.id}/tokens`, '{}');
    expect(t.ok, `clerk tokens → HTTP ${t.status}`);
    jwt = (await t.json()).jwt;
    return `session ${session.id}`;
  });

  await step('browse catalog (public)', async () => {
    const r = await gw('GET', '/api/catalog/products?limit=20');
    expect(r.status === 200, `HTTP ${r.status}`);
    const items = r.json.items || r.json.products || r.json;
    expect(Array.isArray(items) && items.length > 0, 'no products — run ./orderflow.sh seed');
    product = items.find((p) => p.active !== false) || items[0];
    product.id = product._id || product.id;
    return `${items.length} products; using "${product.name}" @ ${product.priceInPaise} paise`;
  });

  await step('stock before checkout', async () => {
    const r = await gw('GET', `/api/inventory/stock/${product.id}`);
    expect(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)} — run ./orderflow.sh seed`);
    before = r.json;
    expect(before.available >= 1, `product has no available stock (${before.available})`);
    return `available=${before.available} reserved=${before.reserved}`;
  });

  await step('cart: clear + add 1', async () => {
    const d = await gw('DELETE', '/api/cart/');
    expect([200, 204].includes(d.status), `DELETE → HTTP ${d.status}`);
    const a = await gw('POST', '/api/cart/items', { productId: product.id, quantity: 1 });
    expect(a.status === 200 || a.status === 201, `POST items → HTTP ${a.status} ${JSON.stringify(a.json).slice(0, 160)}`);
    return `${a.json.itemCount} line, quantity ${a.json.totalQuantity}`;
  });

  await step('checkout → AWAITING_PAYMENT', async () => {
    const r = await gw('POST', '/api/orders/', { note: 'smoke test' }, { 'Idempotency-Key': `idem-${REQUEST_ID}` });
    expect(r.status === 201, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    order = r.json;
    expect(order.status === 'AWAITING_PAYMENT', `status ${order.status}`);
    return `order ${order.orderId} total ${order.totalInPaise} razorpayOrderId ${order.payment.razorpayOrderId}`;
  });

  await step('stock reserved (available -1, reserved +1)', async () => {
    const r = await gw('GET', `/api/inventory/stock/${product.id}`);
    expect(r.json.available === before.available - 1 && r.json.reserved === before.reserved + 1,
      `expected available=${before.available - 1} reserved=${before.reserved + 1}, got available=${r.json.available} reserved=${r.json.reserved}`);
    return `available=${r.json.available} reserved=${r.json.reserved}`;
  });

  await step('payment webhook via gateway (signed, no JWT)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const rzpPayment = `pay_smoke${randomBytes(5).toString('hex')}`;
    const payload = { payment: { entity: { id: rzpPayment, entity: 'payment', amount: order.totalInPaise, currency: 'INR', status: 'captured', order_id: order.payment.razorpayOrderId, captured: true, method: 'card', email: 'smoke@example.com', contact: '+910000000000', notes: { orderId: order.orderId }, created_at: now } } };
    const body = JSON.stringify({ entity: 'event', account_id: 'acc_SMOKE', event: 'payment.captured', contains: ['payment'], payload, created_at: now });
    const signature = createHmac('sha256', cfg('RAZORPAY_WEBHOOK_SECRET')).update(body).digest('hex');
    const saved = jwt; jwt = null;   // prove the route is public: no Authorization header at all
    // 1) a BAD signature must be rejected by Payment itself (the gateway lets it through unauthenticated)
    const bad = await gw('POST', '/api/payment-webhooks/razorpay', body, { 'X-Razorpay-Signature': 'deadbeef'.repeat(8), 'X-Razorpay-Event-Id': `evt_smoke_bad_${randomBytes(6).toString('hex')}` });
    expect(bad.status === 400 || bad.status === 401, `unsigned webhook should be rejected, got HTTP ${bad.status}`);
    // 2) the correctly signed one is processed
    const r = await gw('POST', '/api/payment-webhooks/razorpay', body, { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': `evt_smoke_${randomBytes(6).toString('hex')}` });
    jwt = saved;
    expect(r.status === 200 && r.json.status === 'processed', `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    return `bad signature → HTTP ${bad.status} ${bad.json?.error ?? ''}; signed → ${r.json.note}`;
  });

  await step(`order CONFIRMED within ${TIMEOUT_S}s`, async () => {
    const deadline = Date.now() + TIMEOUT_S * 1000;
    let last;
    while (Date.now() < deadline) {
      const r = await gw('GET', `/api/orders/${order.orderId}/status`);
      last = r.json.status;
      if (last === 'CONFIRMED') return `after ${Math.round((Date.now() - startedAt) / 100) / 10}s total`;
      if (['FAILED', 'CANCELLED'].includes(last)) throw new Error(`order reached ${last}`);
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(`still ${last}`);
  });

  await step('stock deducted permanently (reserved released, available stays -1)', async () => {
    const deadline = Date.now() + 15000;
    let r;
    while (Date.now() < deadline) {
      r = await gw('GET', `/api/inventory/stock/${product.id}`);
      if (r.json.available === before.available - 1 && r.json.reserved === before.reserved) return `available=${r.json.available} reserved=${r.json.reserved}`;
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(`got available=${r.json.available} reserved=${r.json.reserved}, expected available=${before.available - 1} reserved=${before.reserved}`);
  });

  await step('payment record SUCCESS', async () => {
    const r = await gw('GET', `/api/payments/payments/${order.orderId}`);
    expect(r.status === 200 && r.json.status === 'SUCCESS', `HTTP ${r.status} status ${r.json?.status}`);
    return `paymentId ${r.json.paymentId}`;
  });

  await step('notification sent (worker log)', async () => {
    const messageId = `notify-${order.orderId}-order.confirmed`;
    // The worker retries transient failures (e.g. a Clerk TLS reset) after 5 s / 10 s / 20 s — wait through the first two.
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      let logs = '';
      try { logs = execFileSync('docker', ['logs', '--since', '5m', 'orderflow-notification'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (err) { return `skipped — docker logs unavailable (${String(err.message).split('\n')[0]})`; }
      const line = logs.split('\n').find((l) => l.includes(messageId) && l.includes('notification sent'));
      if (line) return `${messageId} → ${JSON.parse(line).template} (X-Request-Id ${JSON.parse(line).requestId})`;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error(`no "notification sent" line for ${messageId} in orderflow-notification logs`);
  });
} catch {
  /* reported by step() */
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${failed === 0 ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED'}: ${passed}/${results.length} checks passed in ${Math.round((Date.now() - startedAt) / 100) / 10}s${order ? `  (order ${order.orderId}, trace ${REQUEST_ID})` : ''}`);
process.exit(failed === 0 ? 0 : 1);
