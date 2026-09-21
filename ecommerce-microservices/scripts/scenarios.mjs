#!/usr/bin/env node
/**
 * OrderFlow end-to-end scenarios (Step 8, Part E) — run against the running
 * stack through the API Gateway, exactly like a browser + Razorpay would.
 * Every scenario prints what it OBSERVED (HTTP results, stock numbers, order
 * status history, database rows) — nothing is asserted silently.
 *
 *   node scripts/scenarios.mjs happy          1  checkout → pay → CONFIRMED, with every database's final state
 *   node scripts/scenarios.mjs oos            2  checkout for more than available → clean rejection
 *   node scripts/scenarios.mjs payfail        3  payment.failed webhook → order FAILED, stock released, notification
 *   node scripts/scenarios.mjs abandon        4  never pay: watch the hold expire / the order be reconciled
 *   node scripts/scenarios.mjs cancel         5  cancel a paid order → refund once (cancel twice = no double refund)
 *   node scripts/scenarios.mjs concurrency    6  N simultaneous checkouts for a product with small stock
 *
 * Options: --product <id> (default: first seeded product), --users <n> (scenario 6, default 20),
 *          --stock <n> (scenario 6, default 5), --wait <s> (scenario 4, default 120),
 *          --stub <url> (scenario 5: the Razorpay test double Payment is pointed at, e.g. http://localhost:9095)
 *
 * Needs: node ≥ 20, docker on PATH (database dumps use `docker exec`), the
 * root .env (CLERK_SECRET_KEY, RAZORPAY_WEBHOOK_SECRET, SMOKE_CLERK_USER_ID).
 * Scenario 6 creates temporary Clerk users (orderflow-load-<n>@example.com)
 * and deletes them again at the end.
 */
import { randomBytes } from 'node:crypto';
import { args, opt, cfg, sleep, log, hr, clerk, tokenFor, client, clientFor, webhook, waitStatus, stock, pickProduct, checkout, sql, mongo, history, dumpAll } from './lib/e2e.mjs';

// ---------------------------------------------------------------------------
const scenarios = {
  async happy() {
    const userId = cfg('SMOKE_CLERK_USER_ID'); const requestId = `scn1-${Date.now().toString(36)}`;
    const gw = await clientFor(userId, requestId);
    const p = await pickProduct(gw);
    const before = await stock(gw, p.id);
    log(`product ${p.name} (${p.id})  stock before: ${JSON.stringify(before)}  requestId ${requestId}`);
    const r = await checkout(gw, p.id, 2, requestId);
    log(`checkout → HTTP ${r.status} status=${r.json.status} orderId=${r.json.orderId} total=${r.json.totalInPaise} reservation=${r.json.reservation?.reservationId}`);
    const o = r.json;
    log(`stock after reserve: ${JSON.stringify(await stock(gw, p.id))}  (expected available ${before.available - 2}, reserved ${before.reserved + 2})`);
    log(`payment created:     ${JSON.stringify((await gw('GET', `/api/payments/payments/${o.orderId}`)).json.status)}`);
    await webhook(gw, 'payment.captured', { razorpayOrderId: o.payment.razorpayOrderId, amount: o.totalInPaise, orderId: o.orderId });
    log(`order status:        ${await waitStatus(gw, o.orderId, ['CONFIRMED', 'FAILED', 'CANCELLED'])}`);
    await sleep(3000);
    log(`stock after confirm: ${JSON.stringify(await stock(gw, p.id))}  (expected available ${before.available - 2}, reserved ${before.reserved})`);
    await sleep(4000);
    dumpAll(o.orderId, p.id, userId);
  },

  async oos() {
    const userId = cfg('SMOKE_CLERK_USER_ID'); const requestId = `scn2-${Date.now().toString(36)}`;
    const gw = await clientFor(userId, requestId);
    const p = await pickProduct(gw);
    // make it small and known: SET available = 3
    log('set stock:', JSON.stringify((await gw('POST', `/api/inventory/stock/${p.id}/adjust`, { operation: 'SET', quantity: 3 })).json));
    const before = await stock(gw, p.id);
    log(`product ${p.name}  stock before: ${JSON.stringify(before)}`);
    const r = await checkout(gw, p.id, 4, requestId);
    log(`checkout for 4 → HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
    const orderId = r.json.orderId;
    log(`stock after:  ${JSON.stringify(await stock(gw, p.id))}  (expected unchanged: ${JSON.stringify(before)})`);
    if (orderId) {
      log(`payment record: HTTP ${(await gw('GET', `/api/payments/payments/${orderId}`)).status} (404 = no payment was ever created)`);
      log('order history:\n' + history(orderId).split('\n').map((l) => '  ' + l).join('\n'));
      log('reservation rows for this order:', sql('inventory_db', `select count(*) from reservation where order_id='${orderId}'`), '(0 = nothing was held)');
    }
    const cart = await gw('GET', '/api/cart/');
    log(`cart after rejection: ${cart.json.itemCount} line(s) (kept, so the user can adjust the quantity)`);
  },

  async payfail() {
    const userId = cfg('SMOKE_CLERK_USER_ID'); const requestId = `scn3-${Date.now().toString(36)}`;
    const gw = await clientFor(userId, requestId);
    const p = await pickProduct(gw);
    const before = await stock(gw, p.id);
    log(`product ${p.name}  stock before: ${JSON.stringify(before)}`);
    const o = (await checkout(gw, p.id, 1, requestId)).json;
    log(`checkout → ${o.status} orderId=${o.orderId}`);
    log(`stock reserved: ${JSON.stringify(await stock(gw, p.id))}`);
    await webhook(gw, 'payment.failed', { razorpayOrderId: o.payment.razorpayOrderId, amount: o.totalInPaise, orderId: o.orderId, reason: 'Card declined by issuing bank' });
    log(`order status: ${await waitStatus(gw, o.orderId, ['FAILED', 'CANCELLED', 'CONFIRMED'])}`);
    await sleep(4000);
    log(`stock after failure: ${JSON.stringify(await stock(gw, p.id))}  (expected back to ${JSON.stringify(before)})`);
    log('order history:\n' + history(o.orderId).split('\n').map((l) => '  ' + l).join('\n'));
    log('outbox:\n' + sql('order_db', `select destination, event_type, published_at is not null from outbox_event where order_id='${o.orderId}' order by created_at`).split('\n').map((l) => '  ' + l).join('\n'));
    log('reservation:', sql('inventory_db', `select status, resolved_at from reservation where order_id='${o.orderId}'`));
    log('payment:    ', sql('payment_db', `select status, failure_reason from payment_transaction where order_id='${o.orderId}'`));
    await sleep(4000);
    log('notification:', mongo('notification_db', `JSON.stringify(db.sent_notifications.find({orderId:'${o.orderId}'},{_id:1,status:1,template:1}).toArray())`));
  },

  async abandon() {
    const userId = cfg('SMOKE_CLERK_USER_ID'); const requestId = `scn4-${Date.now().toString(36)}`;
    const gw = await clientFor(userId, requestId);
    const p = await pickProduct(gw);
    const before = await stock(gw, p.id);
    log(`product ${p.name}  stock before: ${JSON.stringify(before)}`);
    const o = (await checkout(gw, p.id, 1, requestId)).json;
    log(`checkout → ${o.status} orderId=${o.orderId} hold expires ${o.reservation?.expiresAt}  — NOT paying`);
    const waitS = Number(opt('wait', 120)); const t0 = Date.now(); let last = o.status; let lastStock = JSON.stringify(await stock(gw, p.id));
    log(`  t+0s  order=${last} stock=${lastStock}`);
    while (Date.now() - t0 < waitS * 1000) {
      await sleep(3000);
      const s = (await gw('GET', `/api/orders/${o.orderId}/status`)).json.status; const st = JSON.stringify(await stock(gw, p.id));
      if (s !== last || st !== lastStock) { log(`  t+${Math.round((Date.now() - t0) / 1000)}s  order=${s} stock=${st}`); last = s; lastStock = st; }
      if (['CANCELLED', 'FAILED'].includes(s) && st === JSON.stringify(before)) break;
    }
    log('order history:\n' + history(o.orderId).split('\n').map((l) => '  ' + l).join('\n'));
    log('reservation:', sql('inventory_db', `select status, expires_at, resolved_at from reservation where order_id='${o.orderId}'`));
    log('payment:    ', sql('payment_db', `select status from payment_transaction where order_id='${o.orderId}'`));
  },

  async cancel() {
    const userId = cfg('SMOKE_CLERK_USER_ID'); const requestId = `scn5-${Date.now().toString(36)}`;
    const gw = await clientFor(userId, requestId);
    const p = await pickProduct(gw);
    const before = await stock(gw, p.id);
    log(`product ${p.name}  stock before: ${JSON.stringify(before)}`);
    const o = (await checkout(gw, p.id, 1, requestId)).json;
    log(`checkout → ${o.status} orderId=${o.orderId}`);
    await webhook(gw, 'payment.captured', { razorpayOrderId: o.payment.razorpayOrderId, amount: o.totalInPaise, orderId: o.orderId });
    log(`order status: ${await waitStatus(gw, o.orderId, ['CONFIRMED'])}`);
    await sleep(2000);
    log(`stock after confirm: ${JSON.stringify(await stock(gw, p.id))}`);
    const c1 = await gw('POST', `/api/orders/${o.orderId}/cancel`, { reason: 'changed my mind' });
    log(`cancel #1 → HTTP ${c1.status} status=${c1.json.status ?? c1.json.order?.status} ${JSON.stringify(c1.json).slice(0, 160)}`);
    const c2 = await gw('POST', `/api/orders/${o.orderId}/cancel`, { reason: 'clicked again' });
    log(`cancel #2 → HTTP ${c2.status} ${JSON.stringify(c2.json).slice(0, 160)}`);
    await sleep(8000);
    log(`stock after cancel: ${JSON.stringify(await stock(gw, p.id))}  (expected restocked to ${JSON.stringify(before)})`);
    log(`payment via API:   ${JSON.stringify((await gw('GET', `/api/payments/payments/${o.orderId}`)).json).slice(0, 300)}`);
    log('order history:\n' + history(o.orderId).split('\n').map((l) => '  ' + l).join('\n'));
    log('payment_refund rows:', sql('payment_db', `select count(*), string_agg(r.status, ',') from payment_refund r join payment_transaction t on t.id=r.payment_id where t.order_id='${o.orderId}'`), '(exactly 1 expected)');
    log('outbox OrderCancelled rows:', sql('order_db', `select count(*) from outbox_event where order_id='${o.orderId}' and event_type='OrderCancelled'`), '(exactly 1 expected)');
    await sleep(3000);
    log('notifications:', mongo('notification_db', `JSON.stringify(db.sent_notifications.find({orderId:'${o.orderId}'},{_id:1,status:1,template:1}).toArray())`));
  },

  async concurrency() {
    const n = Number(opt('users', 20)); const stockN = Number(opt('stock', 5));
    const admin = await clientFor(cfg('SMOKE_CLERK_USER_ID'), 'scn6-admin');
    const p = await pickProduct(admin);
    log('set stock:', JSON.stringify((await admin('POST', `/api/inventory/stock/${p.id}/adjust`, { operation: 'SET', quantity: stockN })).json));
    const before = await stock(admin, p.id);
    log(`product ${p.name}  stock: ${JSON.stringify(before)}  users: ${n}`);
    hr(`creating ${n} temporary Clerk users + carts`);
    const users = [];
    for (let i = 0; i < n; i += 1) {
      const email = `orderflow-load-${i}@example.com`;
      let u;
      try { u = await clerk('POST', '/v1/users', { email_address: [email], first_name: 'Load', last_name: `User${i}`, skip_password_requirement: true }); }
      catch (e) { const found = await clerk('GET', `/v1/users?email_address=${encodeURIComponent(email)}`); u = found[0]; if (!u) throw e; }
      const gw = client(await tokenFor(u.id), `scn6-u${i}`, u.id);
      await gw('DELETE', '/api/cart/');
      const a = await gw('POST', '/api/cart/items', { productId: p.id, quantity: 1 });
      if (a.status !== 200) throw new Error(`cart for user ${i}: HTTP ${a.status}`);
      users.push({ i, id: u.id, gw });
      process.stdout.write(`\r  ready: ${i + 1}/${n}`);
    }
    log('');
    hr(`firing ${n} checkouts simultaneously`);
    const t0 = performance.now();
    const results = await Promise.all(users.map((u) => u.gw('POST', '/api/orders/', { note: 'load' }, { 'Idempotency-Key': `idem-load-${u.i}-${Date.now()}` }).then((r) => ({ ...r, i: u.i }))));
    const took = Math.round(performance.now() - t0);
    const byStatus = {};
    for (const r of results) { const k = `${r.status} ${r.json.status || r.json.error || ''}`.trim(); byStatus[k] = (byStatus[k] || 0) + 1; }
    log(`all ${n} responses in ${took} ms:`, JSON.stringify(byStatus));
    const created = results.filter((r) => r.status === 201);
    log(`stock after checkout burst: ${JSON.stringify(await stock(admin, p.id))}  (expected available 0, reserved ${stockN})`);
    hr(`paying the ${created.length} accepted orders`);
    for (const r of created) await webhook(users[r.i].gw, 'payment.captured', { razorpayOrderId: r.json.payment.razorpayOrderId, amount: r.json.totalInPaise, orderId: r.json.orderId });
    const finals = {};
    for (const r of created) { const s = await waitStatus(users[r.i].gw, r.json.orderId, ['CONFIRMED', 'FAILED', 'CANCELLED']); finals[s] = (finals[s] || 0) + 1; }
    await sleep(3000);
    log(`final order states: ${JSON.stringify(finals)}`);
    log(`final stock: ${JSON.stringify(await stock(admin, p.id))}  (expected available 0, reserved 0)`);
    log('inventory row:', sql('inventory_db', `select available, reserved, version from inventory where product_id='${p.id}'`));
    log('CONFIRMED orders for this product in order_db:', sql('order_db', `select count(*) from orders o join order_item i on i.order_id=o.id where i.product_id='${p.id}' and o.status='CONFIRMED' and o.created_at > now() - interval '3 minutes'`));
    hr('cleanup: deleting temporary Clerk users');
    for (const u of users) { try { await clerk('DELETE', `/v1/users/${u.id}`); } catch { /* best effort */ } }
    log(`deleted ${users.length} users`);
  },
};

const scenario = args[0];
if (!scenarios[scenario]) { console.error('usage: scenarios.mjs happy|oos|payfail|abandon|cancel|concurrency [options]'); process.exit(2); }
await scenarios[scenario]();
