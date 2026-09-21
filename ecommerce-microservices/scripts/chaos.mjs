#!/usr/bin/env node
/**
 * OrderFlow chaos scenarios (Step 8, scenario 7): kill a dependency while a
 * checkout is in flight, watch the system degrade WITHOUT corrupting data,
 * bring the dependency back and watch it recover. Uses `docker stop/start`
 * on the running Compose stack and reports what it observes.
 *
 *   node scripts/chaos.mjs kafka       stop Kafka: checkout still completes (outbox holds the events),
 *                                      the paid order is confirmed by reconciliation once Kafka is back
 *   node scripts/chaos.mjs rabbitmq    stop RabbitMQ: order confirms, the notification command waits in
 *                                      the outbox and is delivered when RabbitMQ returns
 *   node scripts/chaos.mjs inventory   stop Inventory: checkouts fail fast (503), Order's circuit breaker
 *                                      opens, closes again when Inventory returns; a checkout then succeeds
 *
 * Options: --stub <url> (Payment is pointed at the Razorpay test double), --product <id>,
 *          --hold <s> (kafka: keep the broker down this long after the webhook, to outlast the producer buffer)
 */
import { execFileSync } from 'node:child_process';
import { args, opt, cfg, sleep, log, hr, tokenFor, client, clientFor, webhook, waitStatus, stock, pickProduct, checkout, sql, history } from './lib/e2e.mjs';

const which = args[0];
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const orderHealth = () => JSON.parse(docker('exec', 'orderflow-order', 'wget', '-qO-', 'http://127.0.0.1:8081/health'));
const stamp = () => new Date().toISOString().slice(11, 23);
const outbox = (orderId) => sql('order_db', `select destination, event_type, attempts, published_at is not null as published, coalesce(last_error,'') from outbox_event where order_id='${orderId}' order by created_at`);

async function setup(tag) {
  const userId = cfg('SMOKE_CLERK_USER_ID'); const requestId = `chaos-${tag}-${Date.now().toString(36)}`;
  const gw = await clientFor(userId, requestId);
  const p = await pickProduct(gw);
  if ((await stock(gw, p.id)).available < 5) await gw('POST', `/api/inventory/stock/${p.id}/adjust`, { operation: 'SET', quantity: 20 });
  log(`product ${p.name}  stock: ${JSON.stringify(await stock(gw, p.id))}  requestId ${requestId}`);
  return { gw, p, requestId };
}

const cases = {
  async kafka() {
    const { gw, p } = await setup('kafka');
    hr(`${stamp()} docker stop orderflow-kafka`); docker('stop', 'orderflow-kafka');
    await sleep(3000);
    const h = orderHealth(); log(`order /health while Kafka is down: status=${h.status} kafka=${h.kafka?.state}`);
    const r = await checkout(gw, p.id, 1, 'chaos-kafka');
    log(`${stamp()} checkout with Kafka DOWN → HTTP ${r.status} ${r.json.status || r.json.error}  orderId=${r.json.orderId}`);
    const o = r.json;
    log(`stock: ${JSON.stringify(await stock(gw, p.id))}  (reserved — Inventory's REST path does not need Kafka)`);
    log('outbox now:\n' + outbox(o.orderId).split('\n').map((l) => '  ' + l).join('\n'));
    await webhook(gw, 'payment.captured', { razorpayOrderId: o.payment.razorpayOrderId, amount: o.totalInPaise, orderId: o.orderId });
    log(`payment row: ${sql('payment_db', `select status from payment_transaction where order_id='${o.orderId}'`)}  order status: ${(await gw('GET', `/api/orders/${o.orderId}/status`)).json.status}  ← PaymentSucceeded could not be published (Payment publishes best-effort)`);
    const payLog = docker('logs', '--since', '2m', 'orderflow-payment').split('\n').filter((l) => l.includes('publish FAILED')).slice(-1)[0];
    if (payLog) log(`payment log: ${JSON.parse(payLog).msg} — ${JSON.parse(payLog).error?.slice?.(0, 80) || ''}`);
    const hold = Number(opt('hold', 0));
    if (hold > 0) { log(`keeping Kafka down for ${hold}s more (longer than the producers' delivery.timeout.ms, so buffered sends expire)`); await sleep(hold * 1000); }
    const payLog2 = docker('logs', '--since', '5m', 'orderflow-payment').split('\n').filter((l) => l.includes('publish FAILED')).slice(-1)[0];
    if (payLog2) { const j = JSON.parse(payLog2); log(`payment log: ${j.msg} — ${String(j.error || '').slice(0, 100)}`); }
    hr(`${stamp()} docker start orderflow-kafka`); docker('start', 'orderflow-kafka');
    const t0 = Date.now(); let s = 'AWAITING_PAYMENT';
    while (Date.now() - t0 < 240000) {
      await sleep(5000);
      const h2 = orderHealth(); s = (await gw('GET', `/api/orders/${o.orderId}/status`)).json.status;
      log(`  t+${Math.round((Date.now() - t0) / 1000)}s  order kafka=${h2.kafka?.state} outbox.pending=${h2.outbox?.pending}  order=${s}`);
      if (s === 'CONFIRMED') break;
    }
    log('order history:\n' + history(o.orderId).split('\n').map((l) => '  ' + l).join('\n'));
    log('outbox after:\n' + outbox(o.orderId).split('\n').map((l) => '  ' + l).join('\n'));
    log(`stock: ${JSON.stringify(await stock(gw, p.id))}`);
  },

  async rabbitmq() {
    const { gw, p } = await setup('rabbit');
    hr(`${stamp()} docker stop orderflow-rabbitmq`); docker('stop', 'orderflow-rabbitmq');
    await sleep(3000);
    const r = await checkout(gw, p.id, 1, 'chaos-rabbit');
    log(`${stamp()} checkout with RabbitMQ DOWN → HTTP ${r.status} ${r.json.status}  orderId=${r.json.orderId}`);
    const o = r.json;
    await webhook(gw, 'payment.captured', { razorpayOrderId: o.payment.razorpayOrderId, amount: o.totalInPaise, orderId: o.orderId });
    log(`order status: ${await waitStatus(gw, o.orderId, ['CONFIRMED'])}  (the saga runs on Kafka — RabbitMQ is only the notification hop)`);
    await sleep(8000);
    const h = orderHealth(); log(`order /health: status=${h.status} rabbitmq=${h.rabbitmq?.state} outbox.pending=${h.outbox?.pending}`);
    log('outbox while RabbitMQ is down:\n' + outbox(o.orderId).split('\n').map((l) => '  ' + l).join('\n'));
    const nl = docker('logs', '--since', '1m', 'orderflow-notification').split('\n').filter((l) => l.includes('reconnecting')).slice(-1)[0];
    if (nl) log(`notification worker: ${JSON.parse(nl).msg}`);
    hr(`${stamp()} docker start orderflow-rabbitmq`); docker('start', 'orderflow-rabbitmq');
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      await sleep(5000);
      const row = outbox(o.orderId).split('\n').find((l) => l.startsWith('RABBITMQ'));
      const sent = docker('logs', '--since', '3m', 'orderflow-notification').split('\n').some((l) => l.includes(`notify-${o.orderId}-order.confirmed`) && l.includes('notification sent'));
      log(`  t+${Math.round((Date.now() - t0) / 1000)}s  outbox RABBITMQ row: ${row}   notification sent: ${sent}`);
      if (sent) break;
    }
  },

  async inventory() {
    const { gw, p } = await setup('inventory');
    hr(`${stamp()} docker stop orderflow-inventory`); docker('stop', 'orderflow-inventory');
    await sleep(2000);
    const codes = [];
    for (let i = 1; i <= 6; i += 1) {
      const t0 = performance.now();
      const r = await checkout(gw, p.id, 1, `chaos-inv-${i}`);
      const b = orderHealth().dependencies?.inventory;
      codes.push(`${r.status}`);
      log(`  checkout #${i}: HTTP ${r.status} ${r.json.error || r.json.status}  ${Math.round(performance.now() - t0)} ms   breaker(inventory)=${b?.circuitBreaker} failureRate=${b?.failureRatePercent}%`);
    }
    log(`orders left behind: ${sql('order_db', `select status, count(*) from orders where created_by_request_id like 'chaos-inv-%' and created_at > now() - interval '2 minutes' group by status`)}`);
    hr(`${stamp()} docker start orderflow-inventory`); docker('start', 'orderflow-inventory');
    for (let i = 0; i < 24; i += 1) { await sleep(5000); if (docker('ps', '--filter', 'name=orderflow-inventory', '--format', '{{.Status}}').includes('healthy')) break; }
    log(`inventory healthy again at ${stamp()}`);
    for (let i = 1; i <= 4; i += 1) {
      const r = await checkout(gw, p.id, 1, `chaos-inv-back-${i}`);
      const b = orderHealth().dependencies?.inventory;
      log(`  checkout after recovery #${i}: HTTP ${r.status} ${r.json.status || r.json.error}   breaker(inventory)=${b?.circuitBreaker} failureRate=${b?.failureRatePercent}%`);
      if (r.status === 201) { await gw('POST', `/api/orders/${r.json.orderId}/cancel`, { reason: 'chaos cleanup' }); }
      await sleep(1500);
    }
    log(`stock: ${JSON.stringify(await stock(gw, p.id))}`);
  },
};

if (!cases[which]) { console.error('usage: chaos.mjs kafka|rabbitmq|inventory'); process.exit(2); }
await cases[which]();
