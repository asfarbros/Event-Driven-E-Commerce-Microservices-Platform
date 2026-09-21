#!/usr/bin/env node
/**
 * Inspect and replay the dead-letter queue.
 *
 *   node scripts/dlq.mjs list                 show every parked message (reason, attempts, when, who) — non-destructive
 *   node scripts/dlq.mjs replay               move ALL parked messages back to the main queue (fresh attempt counter)
 *   node scripts/dlq.mjs replay --message-id notify-<orderId>-order.confirmed     replay one; others stay parked
 *   node scripts/dlq.mjs purge                delete every parked message (asks for --yes)
 *
 * Replay re-publishes to the ORIGINAL exchange with the ORIGINAL routing key
 * (from x-original-routing-key), strips the worker's x-failure-* / x-attempt
 * bookkeeping and RabbitMQ's x-death, and acks the DLQ copy only after the
 * broker confirmed the republish — a replay can never lose a message. The
 * worker's dedupe ledger still applies: a replayed message whose messageId
 * was already sent is acked as a duplicate, not sent again.
 */
import { env, withChannel, publishConfirmed, arg, has } from './lib.mjs';

const { config, mgmt } = env();
const { rabbit } = config;
const command = process.argv[2];
const only = arg('--message-id', null);

const WORKER_HEADERS = ['x-failure-kind', 'x-failure-reason', 'x-failure-details', 'x-attempts', 'x-attempt', 'x-last-error', 'x-first-failed-at',
  'x-dead-lettered-at', 'x-dead-lettered-by', 'x-original-queue', 'x-original-routing-key',
  'x-death', 'x-first-death-exchange', 'x-first-death-queue', 'x-first-death-reason', 'x-last-death-exchange', 'x-last-death-queue', 'x-last-death-reason'];

const str = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v);

async function list() {
  // Exact count via AMQP (management counters lag), then a management API
  // peek (ack_requeue_true) that leaves the queue untouched.
  const { messageCount } = await withChannel(config, (ch) => ch.checkQueue(rabbit.deadLetterQueue));
  console.log(`${rabbit.deadLetterQueue}: ${messageCount} message(s)`);
  if (!messageCount) return;
  const res = await fetch(`${mgmt.base}/queues/${mgmt.vhost}/${encodeURIComponent(rabbit.deadLetterQueue)}/get`, {
    method: 'POST', headers: { Authorization: mgmt.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: Math.min(messageCount, 100), ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 4000 }),
  });
  if (!res.ok) throw new Error(`peek failed: HTTP ${res.status}`);
  for (const m of await res.json()) {
    const h = m.properties.headers || {};
    let body = m.payload;
    try { body = JSON.parse(m.payload); } catch { /* keep raw */ }
    console.log('');
    console.log(`  messageId      ${m.properties.message_id ?? body?.messageId ?? '-'}`);
    console.log(`  orderId        ${body?.orderId ?? '-'}   commandType ${m.properties.type ?? body?.commandType ?? '-'}`);
    console.log(`  requestId      ${m.properties.correlation_id ?? h['X-Request-Id'] ?? '-'}`);
    console.log(`  failure        ${h['x-failure-kind'] ?? '-'} — ${h['x-failure-reason'] ?? '-'}`);
    if (h['x-failure-details']) console.log(`  details        ${h['x-failure-details']}`);
    console.log(`  attempts       ${h['x-attempts'] ?? '-'}   first failed ${h['x-first-failed-at'] ?? '-'}   dead-lettered ${h['x-dead-lettered-at'] ?? '-'} by ${h['x-dead-lettered-by'] ?? '-'}`);
    console.log(`  from           ${h['x-original-queue'] ?? '-'} (routing key ${h['x-original-routing-key'] ?? m.routing_key})`);
    if (typeof body !== 'object') console.log(`  body (raw)     ${String(m.payload).slice(0, 200)}`);
  }
}

async function replay() {
  let moved = 0; let skipped = 0;
  await withChannel(config, async (ch) => {
    await ch.prefetch(1);
    // Bounded by the depth at start so a message we put back cannot be re-read forever.
    const { messageCount } = await ch.checkQueue(rabbit.deadLetterQueue);
    for (let i = 0; i < messageCount; i += 1) {
      const msg = await ch.get(rabbit.deadLetterQueue, { noAck: false });
      if (!msg) break;
      const h = msg.properties.headers || {};
      const messageId = msg.properties.messageId;
      if (only && messageId !== only) { ch.nack(msg, false, true); skipped += 1; continue; }
      const headers = Object.fromEntries(Object.entries(h).filter(([k]) => !WORKER_HEADERS.includes(k)));
      headers['x-replayed-at'] = new Date().toISOString();
      headers['x-replayed-from'] = rabbit.deadLetterQueue;
      const routingKey = str(h['x-original-routing-key']) || msg.fields.routingKey;
      await publishConfirmed(ch, rabbit.exchange, routingKey, msg.content, {
        persistent: true, messageId, correlationId: msg.properties.correlationId, type: msg.properties.type,
        contentType: msg.properties.contentType, contentEncoding: msg.properties.contentEncoding, timestamp: msg.properties.timestamp, headers,
      });
      ch.ack(msg);
      moved += 1;
      console.log(`replayed ${messageId ?? '(no messageId)'} → ${rabbit.exchange} / ${routingKey}`);
    }
  });
  console.log(`done: ${moved} replayed, ${skipped} left in ${rabbit.deadLetterQueue}`);
}

async function purge() {
  if (!has('--yes')) { console.error('refusing to purge without --yes'); process.exit(2); }
  await withChannel(config, async (ch) => {
    const { messageCount } = await ch.purgeQueue(rabbit.deadLetterQueue);
    console.log(`purged ${messageCount} message(s) from ${rabbit.deadLetterQueue}`);
  });
}

const commands = { list, replay, purge };
if (!commands[command]) { console.error('usage: dlq.mjs list | replay [--message-id id] | purge --yes'); process.exit(2); }
await commands[command]();
