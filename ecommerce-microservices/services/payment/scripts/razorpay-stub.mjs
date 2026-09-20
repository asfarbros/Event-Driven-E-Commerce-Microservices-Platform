#!/usr/bin/env node
/**
 * RAZORPAY TEST DOUBLE — a tiny local server that speaks the subset of the
 * Razorpay REST API this service uses, so the refund, reconciliation and
 * circuit-breaker paths can be exercised on a laptop without a browser 2FA
 * step and without real money. It is NOT Razorpay: use it only by pointing
 * RAZORPAY_API_BASE_URL=http://localhost:9095/v1 at it for a verification run.
 * Zero dependencies (Node 18+).
 *
 *   node scripts/razorpay-stub.mjs [--port 9095]
 *
 * Implements (Basic auth required, any key pair):
 *   POST /v1/orders                        create order  → order_STUB…
 *   GET  /v1/orders?receipt=X              list by receipt
 *   GET  /v1/orders/:id                    fetch
 *   GET  /v1/orders/:id/payments           the order's payment attempts
 *   GET  /v1/payments/:id
 *   POST /v1/payments/:id/refund           full refund → rfnd_STUB… (status "processed"), 400 if already refunded / not captured
 *   GET  /v1/payments/:id/refunds
 *   GET  /v1/refunds/:id
 * Control endpoints (no auth) to simulate what a user or an outage would do:
 *   POST /_stub/capture  { "order_id": "order_…" }        the user paid: creates a captured payment (NO webhook is sent — that is the point)
 *   POST /_stub/fail     { "order_id": "order_…" }        the user's attempt failed
 *   POST /_stub/fault    { "mode": "ok" | "down" | "timeout" | "lost-response" }
 *                         down: every API call answers 503; timeout: every API call hangs 30 s;
 *                         lost-response: orders ARE created but the response is a 500 (simulates a lost reply)
 *   GET  /_stub/state                                     everything it holds
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 9095);
const state = { orders: new Map(), payments: new Map(), refunds: new Map(), fault: 'ok', calls: 0 };
const id = (p) => p + 'STUB' + randomBytes(6).toString('hex');
const now = () => Math.floor(Date.now() / 1000);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
const rzpError = (res, status, code, description) => json(res, status, { error: { code, description, source: 'business', step: null, reason: null, metadata: {} } });
const collection = (items) => ({ entity: 'collection', count: items.length, items });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const p = url.pathname;
  try {
    // ---- control endpoints ----
    if (p.startsWith('/_stub/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (p === '/_stub/state') return json(res, 200, { fault: state.fault, calls: state.calls, orders: [...state.orders.values()], payments: [...state.payments.values()], refunds: [...state.refunds.values()] });
      if (p === '/_stub/fault') { state.fault = body.mode ?? 'ok'; console.log(`[stub] fault mode = ${state.fault}`); return json(res, 200, { fault: state.fault }); }
      if (p === '/_stub/capture' || p === '/_stub/fail') {
        const order = state.orders.get(body.order_id);
        if (!order) return json(res, 404, { error: 'unknown order' });
        const captured = p === '/_stub/capture';
        const pay = { id: id('pay_'), entity: 'payment', amount: order.amount, currency: order.currency, status: captured ? 'captured' : 'failed', order_id: order.id, method: 'card', captured, amount_refunded: 0, refund_status: null, error_code: captured ? null : 'BAD_REQUEST_ERROR', error_description: captured ? null : 'Payment failed: card declined', error_reason: captured ? null : 'payment_declined', notes: order.notes, created_at: now() };
        state.payments.set(pay.id, pay);
        if (captured) { order.status = 'paid'; order.amount_paid = order.amount; order.amount_due = 0; }
        order.attempts = (order.attempts ?? 0) + 1;
        console.log(`[stub] ${captured ? 'CAPTURED' : 'FAILED'} payment ${pay.id} for ${order.id} (${order.amount} ${order.currency}) — no webhook sent`);
        return json(res, 200, pay);
      }
      return json(res, 404, { error: 'unknown control endpoint' });
    }

    // ---- API: auth + fault injection ----
    state.calls++;
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Basic ')) return rzpError(res, 401, 'BAD_REQUEST_ERROR', 'Authentication failed');
    if (state.fault === 'down') { console.log(`[stub] 503 (fault=down) ${req.method} ${p}`); return rzpError(res, 503, 'SERVER_ERROR', 'stub is down'); }
    if (state.fault === 'timeout') { console.log(`[stub] hanging (fault=timeout) ${req.method} ${p}`); await new Promise((r) => setTimeout(r, 30000)); return rzpError(res, 504, 'SERVER_ERROR', 'stub timed out'); }

    const body = req.method === 'POST' ? await readBody(req) : {};
    let m;
    if (req.method === 'POST' && p === '/v1/orders') {
      if (!Number.isInteger(body.amount) || body.amount < 100) return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'amount must be at least INR 1.00');
      const order = { id: id('order_'), entity: 'order', amount: body.amount, amount_paid: 0, amount_due: body.amount, currency: body.currency ?? 'INR', receipt: body.receipt ?? null, status: 'created', attempts: 0, notes: body.notes ?? {}, created_at: now() };
      state.orders.set(order.id, order);
      console.log(`[stub] created ${order.id} amount=${order.amount} receipt=${order.receipt}`);
      if (state.fault === 'lost-response') { console.log('[stub] ...but answering 500 (fault=lost-response)'); return rzpError(res, 500, 'SERVER_ERROR', 'stub lost the response'); }
      return json(res, 200, order);
    }
    if (req.method === 'GET' && p === '/v1/orders') {
      const receipt = url.searchParams.get('receipt');
      return json(res, 200, collection([...state.orders.values()].filter((o) => !receipt || o.receipt === receipt)));
    }
    if ((m = p.match(/^\/v1\/orders\/([^/]+)\/payments$/)) && req.method === 'GET') {
      return json(res, 200, collection([...state.payments.values()].filter((x) => x.order_id === m[1])));
    }
    if ((m = p.match(/^\/v1\/orders\/([^/]+)$/)) && req.method === 'GET') {
      const o = state.orders.get(m[1]); return o ? json(res, 200, o) : rzpError(res, 400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
    }
    if ((m = p.match(/^\/v1\/payments\/([^/]+)\/refund$/)) && req.method === 'POST') {
      const pay = state.payments.get(m[1]);
      if (!pay) return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
      if (pay.status !== 'captured') return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'The payment has not been captured');
      const amount = body.amount ?? pay.amount;
      if (pay.amount_refunded + amount > pay.amount) return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'The total refund amount is greater than the refund payment amount');
      const refund = { id: id('rfnd_'), entity: 'refund', amount, currency: pay.currency, payment_id: pay.id, receipt: body.receipt ?? null, notes: body.notes ?? {}, status: 'processed', speed_processed: 'normal', created_at: now() };
      state.refunds.set(refund.id, refund);
      pay.amount_refunded += amount; pay.refund_status = pay.amount_refunded === pay.amount ? 'full' : 'partial'; pay.status = pay.amount_refunded === pay.amount ? 'refunded' : pay.status;
      console.log(`[stub] REFUND ${refund.id} of ${amount} for ${pay.id} (refunds so far for this payment: ${[...state.refunds.values()].filter((r) => r.payment_id === pay.id).length})`);
      return json(res, 200, refund);
    }
    if ((m = p.match(/^\/v1\/payments\/([^/]+)\/refunds$/)) && req.method === 'GET') {
      return json(res, 200, collection([...state.refunds.values()].filter((r) => r.payment_id === m[1])));
    }
    if ((m = p.match(/^\/v1\/payments\/([^/]+)$/)) && req.method === 'GET') {
      const x = state.payments.get(m[1]); return x ? json(res, 200, x) : rzpError(res, 400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
    }
    if ((m = p.match(/^\/v1\/refunds\/([^/]+)$/)) && req.method === 'GET') {
      const x = state.refunds.get(m[1]); return x ? json(res, 200, x) : rzpError(res, 400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
    }
    return rzpError(res, 404, 'BAD_REQUEST_ERROR', 'route not implemented by the stub: ' + req.method + ' ' + p);
  } catch (e) {
    return rzpError(res, 500, 'SERVER_ERROR', e.message);
  }
}).listen(port, () => console.log(`[stub] Razorpay TEST DOUBLE listening on http://localhost:${port}/v1  (this is not Razorpay)`));
