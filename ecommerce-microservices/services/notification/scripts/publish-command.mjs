#!/usr/bin/env node
/**
 * Publish notification commands by hand, exactly as the Order Service does
 * (same exchange, routing keys, AMQP properties and body shape).
 *
 *   node scripts/publish-command.mjs                              one order.confirmed
 *   node scripts/publish-command.mjs --type cancelled             order.cancelled (user cancel, refund)
 *   node scripts/publish-command.mjs --type payment-failed        order.cancelled with status FAILED
 *   node scripts/publish-command.mjs --count 20                   20 distinct orders
 *   node scripts/publish-command.mjs --message-id notify-x --twice  same messageId twice (dedupe test)
 *   node scripts/publish-command.mjs --malformed                   invalid body (→ DLQ immediately)
 *   node scripts/publish-command.mjs --request-id req-demo-1      set the X-Request-Id / correlationId
 *   node scripts/publish-command.mjs --user-id user_abc           recipient userId (default: the e2e user)
 *   node scripts/publish-command.mjs --order-id <uuid>            fixed orderId (default: random)
 */
import { randomUUID } from 'node:crypto';
import { env, withChannel, publishConfirmed, arg, has } from './lib.mjs';

const { config } = env();
const type = arg('--type', 'confirmed');
const count = Number(arg('--count', 1));
const twice = has('--twice');
const malformed = has('--malformed');
const requestId = arg('--request-id', `req-manual-${Date.now().toString(36)}`);
const userId = arg('--user-id', 'user_3JYkPTWs9a02pFod2apjeDjAxK9');
const fixedOrderId = arg('--order-id', null);
const fixedMessageId = arg('--message-id', null);

const items = [
  { productId: '66f1a2b3c4d5e6f7a8b9c0d1', sku: 'HDPH-001', name: 'Noise-cancelling headphones', quantity: 1, unitPriceInPaise: 99900, lineTotalInPaise: 99900 },
  { productId: '66f1a2b3c4d5e6f7a8b9c0d2', sku: 'CBL-USBC', name: 'USB-C cable 2 m', quantity: 2, unitPriceInPaise: 15000, lineTotalInPaise: 30000 },
];

function build(i) {
  const orderId = fixedOrderId || randomUUID();
  const routingKey = type === 'confirmed' ? 'order.confirmed' : 'order.cancelled';
  const commandType = type === 'confirmed' ? 'SendOrderConfirmation' : 'SendOrderCancellation';
  const messageId = fixedMessageId || `notify-${orderId}-${routingKey}`;
  const body = {
    messageId, commandType, version: 1, source: 'order', occurredAt: new Date().toISOString(), correlationId: requestId,
    orderId, userId,
    status: type === 'confirmed' ? 'CONFIRMED' : type === 'payment-failed' ? 'FAILED' : 'CANCELLED',
    totalInPaise: 129900 + i * 100, currency: 'INR',
    ...(type === 'cancelled' ? { reason: 'cancelled by user after payment — refund requested' } : {}),
    ...(type === 'payment-failed' ? { reason: 'payment failed: card declined by issuer' } : {}),
    items,
  };
  return { routingKey, commandType, messageId, body: malformed ? { messageId, commandType: 'SendPigeon', totalInPaise: 'twelve rupees' } : body };
}

await withChannel(config, async (ch) => {
  const n = twice ? 2 : count;
  for (let i = 0; i < n; i += 1) {
    const { routingKey, commandType, messageId, body } = build(twice ? 0 : i);
    await publishConfirmed(ch, config.rabbit.exchange, routingKey, Buffer.from(JSON.stringify(body)), {
      persistent: true, messageId, correlationId: requestId, type: commandType, contentType: 'application/json', contentEncoding: 'UTF-8',
      timestamp: Math.floor(Date.now() / 1000), headers: { 'X-Request-Id': requestId, 'X-Source': 'manual' },
    });
    console.log(`published ${routingKey}  messageId=${messageId}  requestId=${requestId}${malformed ? '  (MALFORMED)' : ''}`);
  }
});
