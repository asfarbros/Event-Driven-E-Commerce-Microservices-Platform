#!/usr/bin/env node
/**
 * Local webhook harness — posts a CORRECTLY SIGNED Razorpay-shaped webhook to
 * the Payment Service without any tunnel. Zero dependencies (Node 18+).
 *
 * It signs exactly like Razorpay does: X-Razorpay-Signature = hex(HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)),
 * and sends X-Razorpay-Event-Id (the id the service deduplicates on).
 * The secret is read from ../../.env (RAZORPAY_WEBHOOK_SECRET) or --secret.
 *
 *   node scripts/send-webhook.mjs payment.captured --order order_ABC --payment pay_XYZ --amount 129900
 *   node scripts/send-webhook.mjs payment.failed   --order order_ABC --payment pay_XYZ --amount 129900 --reason "Card declined by bank"
 *   node scripts/send-webhook.mjs refund.processed --payment pay_XYZ --refund rfnd_123 --amount 129900
 *   node scripts/send-webhook.mjs order.paid       --order order_ABC --payment pay_XYZ --amount 129900
 *
 * Options:
 *   --event-id <id>     provider event id (default: evt_<random>); reuse one to test deduplication
 *   --repeat <n>        send the same signed request n times (idempotency test)
 *   --bad-signature     send a wrong signature (must be rejected with 400)
 *   --url <url>         default http://localhost:<PAYMENT_PORT>/webhooks/razorpay
 *   --secret <s>        override the webhook secret
 *   --order-id <id>     our orderId to place in notes (optional)
 *   --print             print the body that was sent
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const event = args[0];
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);

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
  } catch { return {}; }
}
const env = loadEnv();

if (!event || !['payment.captured', 'payment.failed', 'order.paid', 'refund.processed', 'refund.failed'].includes(event)) {
  console.error('usage: send-webhook.mjs <payment.captured|payment.failed|order.paid|refund.processed|refund.failed> [options]');
  process.exit(2);
}
const secret = opt('secret', process.env.RAZORPAY_WEBHOOK_SECRET ?? env.RAZORPAY_WEBHOOK_SECRET);
if (!secret) { console.error('no webhook secret: set RAZORPAY_WEBHOOK_SECRET in ../../.env or pass --secret'); process.exit(2); }
const url = opt('url', `http://localhost:${process.env.PAYMENT_PORT ?? env.PAYMENT_PORT ?? 8083}/webhooks/razorpay`);
const rzpOrder = opt('order', 'order_' + randomBytes(7).toString('hex'));
const rzpPayment = opt('payment', 'pay_' + randomBytes(7).toString('hex'));
const rzpRefund = opt('refund', 'rfnd_' + randomBytes(7).toString('hex'));
const amount = Number(opt('amount', 129900));
const orderId = opt('order-id', undefined);
const eventId = opt('event-id', 'evt_' + randomBytes(8).toString('hex'));
const repeat = Number(opt('repeat', 1));
const now = Math.floor(Date.now() / 1000);

// Razorpay-shaped entities (with the sensitive fields Razorpay really sends, so the redactor has work to do).
const paymentEntity = (status) => ({
  id: rzpPayment, entity: 'payment', amount, currency: 'INR', status, order_id: rzpOrder, invoice_id: null,
  international: false, method: 'card', amount_refunded: 0, refund_status: null, captured: status === 'captured',
  description: 'OrderFlow order', card_id: 'card_TESTxxxxxxxxxx',
  card: { id: 'card_TESTxxxxxxxxxx', entity: 'card', name: 'Test User', last4: '1111', network: 'Visa', type: 'credit', issuer: 'HDFC' },
  bank: null, wallet: null, vpa: null, email: 'test.user@example.com', contact: '+919999999999', customer_id: 'cust_TESTxxxxxxxx',
  token_id: 'token_TESTxxxxxxxx', notes: orderId ? { orderId } : {},
  fee: 0, tax: 0, error_code: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
  error_description: status === 'failed' ? opt('reason', 'Payment failed because the card was declined by the bank') : null,
  error_source: status === 'failed' ? 'bank' : null, error_step: status === 'failed' ? 'payment_authorization' : null,
  error_reason: status === 'failed' ? 'payment_declined' : null,
  acquirer_data: { auth_code: '123456' }, created_at: now,
});
const refundEntity = (status) => ({
  id: rzpRefund, entity: 'refund', amount, currency: 'INR', payment_id: rzpPayment, notes: {}, receipt: null,
  acquirer_data: { arn: null }, created_at: now, batch_id: null, status, speed_processed: 'normal', speed_requested: 'normal',
});

let payload;
switch (event) {
  case 'payment.captured': payload = { payment: { entity: paymentEntity('captured') } }; break;
  case 'payment.failed':   payload = { payment: { entity: paymentEntity('failed') } }; break;
  case 'order.paid':       payload = { payment: { entity: paymentEntity('captured') }, order: { entity: { id: rzpOrder, entity: 'order', amount, amount_paid: amount, amount_due: 0, currency: 'INR', receipt: orderId ?? null, status: 'paid', attempts: 1, notes: orderId ? { orderId } : {}, created_at: now } } }; break;
  case 'refund.processed': payload = { refund: { entity: refundEntity('processed') }, payment: { entity: paymentEntity('refunded') } }; break;
  case 'refund.failed':    payload = { refund: { entity: refundEntity('failed') }, payment: { entity: paymentEntity('captured') } }; break;
}
const body = JSON.stringify({ entity: 'event', account_id: 'acc_TESTxxxxxxxxxx', event, contains: Object.keys(payload), payload, created_at: now });
const signature = flag('bad-signature') ? 'deadbeef'.repeat(8) : createHmac('sha256', secret).update(body).digest('hex');

if (flag('print')) console.log(body);
console.log(`POST ${url}  event=${event}  X-Razorpay-Event-Id=${eventId}  order=${rzpOrder} payment=${rzpPayment} amount=${amount}${flag('bad-signature') ? '  (BAD SIGNATURE)' : ''}`);
for (let i = 1; i <= repeat; i++) {
  const t0 = performance.now();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId, 'X-Request-Id': `webhook-${eventId}-${i}` }, body });
  console.log(`  #${i}: HTTP ${res.status} ${await res.text()}  (${Math.round(performance.now() - t0)} ms)`);
}
