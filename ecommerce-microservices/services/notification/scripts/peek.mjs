#!/usr/bin/env node
/**
 * Non-destructive peek at any queue (management API "get" with requeue):
 * routing key, messageId, correlation id, type, status, total, headers.
 *
 *   node scripts/peek.mjs                                  the main queue
 *   node scripts/peek.mjs notification.tasks.retry.5000ms  a retry tier
 *   node scripts/peek.mjs notification.tasks.dlq           the DLQ (see dlq.mjs for a friendlier view)
 */
import { env, mgmtGet, withChannel } from './lib.mjs';

const { config, mgmt } = env();
const queue = process.argv[2] || config.rabbit.queue;
const { messageCount, consumerCount } = await withChannel(config, (ch) => ch.checkQueue(queue));
console.log(`${queue}: ${messageCount} messages, ${consumerCount} consumers`);
if (!messageCount) process.exit(0);
const res = await fetch(`${mgmt.base}/queues/${mgmt.vhost}/${encodeURIComponent(queue)}/get`, {
  method: 'POST', headers: { Authorization: mgmt.auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ count: Math.min(messageCount, 50), ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 2000 }),
});
if (!res.ok) throw new Error(`peek failed: HTTP ${res.status} (is RABBITMQ_MANAGEMENT_PORT right?)`);
for (const m of await res.json()) {
  let b = {}; try { b = JSON.parse(m.payload); } catch { /* raw */ }
  console.log(`${m.routing_key.padEnd(16)} msgId=${m.properties.message_id}  corr=${m.properties.correlation_id}  type=${m.properties.type}  status=${b.status}  total=${b.totalInPaise}  user=${b.userId}  headers=${JSON.stringify(m.properties.headers)}`);
}
