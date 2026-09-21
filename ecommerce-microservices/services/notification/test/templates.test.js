import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, templateFor, TEMPLATE_NAMES } from '../src/templates/index.js';
import { renderConsoleMessage } from '../src/channels/console.js';
import { confirmationCommand, cancellationCommand, paymentFailedCommand } from './helpers/fixtures.js';

test('the three required templates exist', () => {
  assert.deepEqual([...TEMPLATE_NAMES].sort(), ['order-cancelled', 'order-confirmed', 'payment-failed']);
});

test('template selection: confirmation, cancellation, and FAILED status → payment-failed', () => {
  assert.equal(templateFor(confirmationCommand()), 'order-confirmed');
  assert.equal(templateFor(cancellationCommand()), 'order-cancelled');
  assert.equal(templateFor(paymentFailedCommand()), 'payment-failed');
  assert.equal(templateFor(cancellationCommand({ status: 'CANCELLED', reason: 'stock hold expired before payment' })), 'order-cancelled');
});

test('order confirmed: subject and body carry rupees rendered from paise', () => {
  const out = render(confirmationCommand());
  assert.equal(out.template, 'order-confirmed');
  assert.match(out.subject, /#7F3D2A10 is confirmed — ₹1,299\.00$/);
  assert.match(out.text, /₹1,299\.00/);
  assert.match(out.text, /₹999\.00/);      // line total of item 1
  assert.match(out.text, /₹300\.00/);      // line total of item 2
  assert.match(out.text, /3 items/);
  assert.doesNotMatch(out.text, /129900|paise/i, 'raw paise must never leak into the customer text');
  assert.match(out.html, /<strong>₹1,299\.00<\/strong>/);
});

test('order cancelled: mentions the reason and the refund when one is requested', () => {
  const out = render(cancellationCommand());
  assert.equal(out.template, 'order-cancelled');
  assert.match(out.subject, /was cancelled$/);
  assert.match(out.text, /Reason: cancelled by user after payment — refund requested/);
  assert.match(out.text, /A refund of ₹1,299\.00 has been requested/);
  const unpaid = render(cancellationCommand({ reason: 'cancelled by user before payment' }));
  assert.match(unpaid.text, /You have not been charged/);
});

test('payment failed: strips the "payment failed:" prefix and says no money was taken', () => {
  const out = render(paymentFailedCommand());
  assert.equal(out.template, 'payment-failed');
  assert.match(out.subject, /^Payment failed for OrderFlow order #7F3D2A10$/);
  assert.match(out.text, /Your bank said: card declined by issuer\./);
  assert.match(out.text, /released back to stock/);
});

test('html escapes product names', () => {
  const cmd = confirmationCommand({ items: [{ ...confirmationCommand().items[0], name: 'Cable <script>alert(1)</script>' }] });
  const out = render(cmd);
  assert.doesNotMatch(out.html, /<script>/);
  assert.match(out.html, /&lt;script&gt;/);
});

test('console rendering masks the recipient and shows the trace id', () => {
  const rendered = render(confirmationCommand());
  const box = renderConsoleMessage({
    from: 'OrderFlow <no-reply@orderflow.local>', to: 'orderflow-e2e@example.com', toName: 'E2E',
    subject: rendered.subject, text: rendered.text, meta: { template: rendered.template, orderId: 'abc', requestId: 'req-1', attempt: 2, channel: 'console' },
  });
  assert.match(box, /ORDER CONFIRMED/);
  assert.match(box, /o\*\*\*@example\.com/);
  assert.doesNotMatch(box, /orderflow-e2e@example\.com/);
  assert.match(box, /X-Request-Id req-1/);
  assert.match(box, /#2 via console/);
});
