/**
 * Shared helpers for scripts/scenarios.mjs and scripts/chaos.mjs: root .env, Clerk tokens (with retry for
 * this laptop's occasional TLS resets), a gateway client, signed Razorpay webhooks, stock/status polling and
 * database dumps through `docker exec`. Never prints secrets.
 */
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const env = Object.fromEntries(readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
export const cfg = (k) => process.env[k] ?? env[k];
export const GATEWAY = process.env.SMOKE_GATEWAY_URL || `http://localhost:${cfg('GATEWAY_PORT')}`;
export const args = process.argv.slice(2);
export const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(...a);
export const hr = (t) => log(`\n=== ${t}`);

// ---------------------------------------------------------------------------
// Clerk + gateway helpers
// ---------------------------------------------------------------------------
const clerkHeaders = { Authorization: `Bearer ${cfg('CLERK_SECRET_KEY')}`, 'Content-Type': 'application/json' };
export async function clerk(method, p, body) {
  let res;
  for (let attempt = 1; ; attempt += 1) {   // this laptop's path to Clerk resets TLS handshakes now and then
    try { res = await fetch(`https://api.clerk.com${p}`, { method, headers: clerkHeaders, body: body === undefined ? undefined : JSON.stringify(body) }); break; }
    catch (e) { if (attempt >= 4 || e.cause?.code !== 'ECONNRESET') throw e; await sleep(300 * attempt); }
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`clerk ${method} ${p} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
export async function tokenFor(userId) {
  const s = await clerk('POST', '/v1/sessions', { user_id: userId });
  return (await clerk('POST', `/v1/sessions/${s.id}/tokens`, {})).jwt;
}
export function client(jwt, requestId, userId = null) {
  // Clerk session tokens live 60 s; long-running scenarios re-mint on a 401 when a userId is known.
  return async (method, p, body, extra = {}) => {
    for (let attempt = 1; ; attempt += 1) {
      const res = await fetch(`${GATEWAY}${p}`, {
        method, headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), 'Content-Type': 'application/json', 'X-Request-Id': requestId, ...extra },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      if (res.status === 401 && userId && jwt && attempt === 1) { jwt = await tokenFor(userId); continue; }
      return { status: res.status, json };
    }
  };
}
/** A gateway client for a user that refreshes its own token. */
export async function clientFor(userId, requestId) { return client(await tokenFor(userId), requestId, userId); }
export async function webhook(gw, event, { razorpayOrderId, amount, orderId, reason }) {
  const now = Math.floor(Date.now() / 1000);
  let rzpPayment = `pay_scn${randomBytes(5).toString('hex')}`;
  // --stub <url>: Payment talks to services/payment/scripts/razorpay-stub.mjs instead of Razorpay, so a refund
  // needs a payment the stub knows about — ask the stub to "capture" the order first and use ITS payment id.
  if (opt('stub') && event === 'payment.captured') {
    const r = await fetch(`${opt('stub')}/_stub/capture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: razorpayOrderId }) });
    if (!r.ok) throw new Error(`stub capture → HTTP ${r.status}`);
    rzpPayment = (await r.json()).id;
    log(`  stub captured ${razorpayOrderId} → payment ${rzpPayment}`);
  }
  const entity = { id: rzpPayment, entity: 'payment', amount, currency: 'INR', status: event === 'payment.captured' ? 'captured' : 'failed', order_id: razorpayOrderId,
    captured: event === 'payment.captured', method: 'card', email: 'scenario@example.com', contact: '+910000000000', notes: { orderId }, created_at: now,
    ...(event === 'payment.failed' ? { error_code: 'BAD_REQUEST_ERROR', error_description: reason || 'Payment failed because the card was declined by the bank', error_source: 'bank', error_step: 'payment_authorization', error_reason: 'payment_declined' } : {}) };
  const body = JSON.stringify({ entity: 'event', account_id: 'acc_SCENARIO', event, contains: ['payment'], payload: { payment: { entity } }, created_at: now });
  const signature = createHmac('sha256', cfg('RAZORPAY_WEBHOOK_SECRET')).update(body).digest('hex');
  const r = await gw('POST', '/api/payment-webhooks/razorpay', body, { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': `evt_scn_${randomBytes(6).toString('hex')}` });
  log(`  webhook ${event} → HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return { ...r, rzpPayment };
}
export async function waitStatus(gw, orderId, wanted, seconds = 45) {
  const deadline = Date.now() + seconds * 1000; let last;
  while (Date.now() < deadline) {
    last = (await gw('GET', `/api/orders/${orderId}/status`)).json.status;
    if (wanted.includes(last)) return last;
    await sleep(500);
  }
  return last;
}
export const stock = async (gw, productId) => { const r = await gw('GET', `/api/inventory/stock/${productId}`); return { available: r.json.available, reserved: r.json.reserved }; };
export async function pickProduct(gw) {
  const forced = opt('product');
  const items = (await gw('GET', '/api/catalog/products?limit=20')).json.items;
  const p = forced ? items.find((i) => (i._id || i.id) === forced) : items.find((i) => i.active !== false);
  if (!p) throw new Error('product not found — seed first');
  return { id: p._id || p.id, name: p.name, price: p.priceInPaise };
}
export async function checkout(gw, productId, quantity, requestId) {
  await gw('DELETE', '/api/cart/');
  const a = await gw('POST', '/api/cart/items', { productId, quantity });
  if (a.status !== 200) throw new Error(`cart add → HTTP ${a.status} ${JSON.stringify(a.json).slice(0, 200)}`);
  return gw('POST', '/api/orders/', { note: `scenario ${args[0] || ''}` }, { 'Idempotency-Key': `idem-${requestId}-${randomBytes(3).toString('hex')}` });
}

// ---------------------------------------------------------------------------
// Database dumps (docker exec; superuser inside the container, no password on the wire)
// ---------------------------------------------------------------------------
export function sql(db, query) {
  try {
    return execFileSync('docker', ['exec', 'orderflow-postgres', 'psql', '-U', cfg('POSTGRES_SUPERUSER'), '-d', db, '-Atc', query, '-F', ' | '], { encoding: 'utf8' }).trim();
  } catch (e) { return `(psql failed: ${String(e.message).split('\n')[0]})`; }
}
export function mongo(db, js) {
  try {
    return execFileSync('docker', ['exec', 'orderflow-mongodb', 'mongosh', '--quiet', '-u', cfg('MONGO_ROOT_USER'), '-p', cfg('MONGO_ROOT_PASSWORD'), '--authenticationDatabase', 'admin', db, '--eval', js], { encoding: 'utf8' }).trim();
  } catch (e) { return `(mongosh failed: ${String(e.message).split('\n')[0]})`; }
}
export function history(orderId) {
  return sql('order_db', `select to_char(created_at,'HH24:MI:SS.MS'), coalesce(from_status,'-'), to_status, trigger, coalesce(reason,'') from order_status_history where order_id='${orderId}' order by created_at`);
}
export function dumpAll(orderId, productId, userId) {
  hr('order_db');
  log('orders:            ', sql('order_db', `select status, payment_status, total_in_paise, item_count, reservation_id, payment_id, failure_reason from orders where id='${orderId}'`));
  log('order_status_history:\n' + history(orderId).split('\n').map((l) => '  ' + l).join('\n'));
  log('outbox_event:\n' + sql('order_db', `select destination, event_type, message_id, attempts, published_at is not null as published, trace_parent is not null as traced from outbox_event where order_id='${orderId}' order by created_at`).split('\n').map((l) => '  ' + l).join('\n'));
  log('processed_event:   ', sql('order_db', `select count(*) from processed_event`), 'rows total');
  hr('inventory_db');
  log('inventory:         ', sql('inventory_db', `select product_id, available, reserved, version from inventory where product_id='${productId}'`));
  log('reservation:       ', sql('inventory_db', `select r.id, r.status, r.expires_at, r.resolved_at, i.quantity from reservation r join reservation_item i on i.reservation_id=r.id where r.order_id='${orderId}'`));
  hr('payment_db');
  log('payment_transaction:', sql('payment_db', `select id, status, amount_in_paise, razorpay_order_id, razorpay_payment_id, coalesce(failure_reason,'') from payment_transaction where order_id='${orderId}'`));
  log('payment_refund:    ', sql('payment_db', `select r.id, r.status, r.amount_in_paise, r.razorpay_refund_id, r.reason from payment_refund r join payment_transaction t on t.id=r.payment_id where t.order_id='${orderId}'`) || '(none)');
  log('webhook_event:     ', sql('payment_db', `select provider_event_id, event_type, processing_status, processing_note from webhook_event where razorpay_order_id in (select razorpay_order_id from payment_transaction where order_id='${orderId}') order by received_at`));
  hr('mongodb');
  log('cart_db.carts:     ', mongo('cart_db', `JSON.stringify(db.carts.findOne({userId:'${userId}'},{items:1,_id:0}))`));
  log('notification_db:   ', mongo('notification_db', `JSON.stringify(db.sent_notifications.find({orderId:'${orderId}'},{_id:1,status:1,template:1,channel:1,requestId:1,attempt:1}).toArray())`));
  hr('notification worker (console channel)');
  try {
    const logs = execFileSync('docker', ['logs', '--since', '10m', 'orderflow-notification'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = logs.split('\n'); const i = lines.findIndex((l) => l.includes(`Order:    ${orderId}`));
    if (i >= 0) log(lines.slice(i - 4, i + 12).join('\n')); else log('  (no rendered notification for this order yet)');
  } catch { log('  (docker logs unavailable)'); }
}

