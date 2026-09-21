/**
 * Templates — simple, data-driven: subject + plain-text body (+ a minimal
 * HTML twin for real mail clients) built from the command's own fields.
 *
 * Template selection:
 *   SendOrderConfirmation                       → order-confirmed
 *   SendOrderCancellation, status === "FAILED"  → payment-failed
 *     (Order marks an order FAILED only when the payment failed; the reason
 *      it sends starts with "payment failed: …")
 *   SendOrderCancellation, anything else        → order-cancelled
 *     (user cancel, stock hold expired, stock confirm failed → refund)
 *
 * Money arrives as integer paise and is rendered ONLY through formatPaise().
 */
import { formatPaise } from '../lib/money.js';

const BRAND = 'OrderFlow';

/** Short human handle for an order id: first 8 hex chars, upper-case. */
export function shortOrderId(orderId) {
  return orderId.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function itemLines(items, currency, total) {
  const nameWidth = Math.min(40, Math.max(...items.map((i) => i.name.length), 4));
  const lines = items.map((i) => {
    const name = i.name.length > nameWidth ? `${i.name.slice(0, nameWidth - 1)}…` : i.name.padEnd(nameWidth);
    return `  ${name}  × ${String(i.quantity).padStart(3)}   ${formatPaise(i.lineTotalInPaise, currency).padStart(14)}`;
  });
  if (total !== undefined) lines.push(`  ${'Total'.padEnd(nameWidth + 10)}${formatPaise(total, currency).padStart(14)}`);
  return lines.join('\n');
}

function itemRows(items, currency) {
  return items.map((i) =>
    `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(i.name)}</td><td style="padding:4px 12px;text-align:right">× ${i.quantity}</td><td style="padding:4px 0;text-align:right">${formatPaise(i.lineTotalInPaise, currency)}</td></tr>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wrapHtml(title, paragraphs, cmd) {
  const total = formatPaise(cmd.totalInPaise, cmd.currency);
  return `<!doctype html><html><body style="font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:560px">
<h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
<table style="border-collapse:collapse;margin:12px 0">${itemRows(cmd.items, cmd.currency)}
<tr><td colspan="2" style="padding:8px 12px 4px 0;border-top:1px solid #ddd"><strong>Total</strong></td><td style="padding:8px 0 4px;text-align:right;border-top:1px solid #ddd"><strong>${total}</strong></td></tr></table>
<p style="color:#666;font-size:12px">Order ${escapeHtml(cmd.orderId)} · ${BRAND}</p>
</body></html>`;
}

const templates = {
  'order-confirmed': (cmd) => {
    const ref = shortOrderId(cmd.orderId);
    const total = formatPaise(cmd.totalInPaise, cmd.currency);
    const count = cmd.items.reduce((n, i) => n + i.quantity, 0);
    const intro = [
      `Thanks for your order! Your payment of ${total} was received and order #${ref} is confirmed.`,
      `We are getting your ${count} item${count === 1 ? '' : 's'} ready for dispatch.`,
    ];
    return {
      subject: `Your ${BRAND} order #${ref} is confirmed — ${total}`,
      text: `${intro[0]}\n${intro[1]}\n\nORDER SUMMARY\n${itemLines(cmd.items, cmd.currency, cmd.totalInPaise)}\n\nOrder reference: ${cmd.orderId}\n\n— ${BRAND}`,
      html: wrapHtml(`Order #${ref} confirmed`, intro, cmd),
    };
  },

  'order-cancelled': (cmd) => {
    const ref = shortOrderId(cmd.orderId);
    const total = formatPaise(cmd.totalInPaise, cmd.currency);
    const refund = /refund/i.test(cmd.reason || '');
    const intro = [
      `Your order #${ref} (${total}) has been cancelled.`,
      `Reason: ${cmd.reason || 'not specified'}.`,
      refund
        ? `A refund of ${total} has been requested and will reach your original payment method in 5–7 working days.`
        : 'You have not been charged for this order.',
    ];
    return {
      subject: `Your ${BRAND} order #${ref} was cancelled`,
      text: `${intro.join('\n')}\n\nITEMS\n${itemLines(cmd.items, cmd.currency)}\n\nOrder reference: ${cmd.orderId}\n\n— ${BRAND}`,
      html: wrapHtml(`Order #${ref} cancelled`, intro, cmd),
    };
  },

  'payment-failed': (cmd) => {
    const ref = shortOrderId(cmd.orderId);
    const total = formatPaise(cmd.totalInPaise, cmd.currency);
    const detail = (cmd.reason || '').replace(/^payment failed:?\s*/i, '');
    const intro = [
      `We could not take the payment of ${total} for order #${ref}, so the order was not placed.`,
      detail ? `Your bank said: ${detail}.` : 'No money was taken.',
      'Your items have been released back to stock. Please try again from your cart when you are ready.',
    ];
    return {
      subject: `Payment failed for ${BRAND} order #${ref}`,
      text: `${intro.join('\n')}\n\nITEMS\n${itemLines(cmd.items, cmd.currency)}\n\nOrder reference: ${cmd.orderId}\n\n— ${BRAND}`,
      html: wrapHtml(`Payment failed for order #${ref}`, intro, cmd),
    };
  },
};

export const TEMPLATE_NAMES = Object.keys(templates);

/** Which template a validated command maps to. */
export function templateFor(cmd) {
  if (cmd.commandType === 'SendOrderConfirmation') return 'order-confirmed';
  if (cmd.commandType === 'SendOrderCancellation') return cmd.status === 'FAILED' ? 'payment-failed' : 'order-cancelled';
  return null;
}

/** @returns {{ template: string, subject: string, text: string, html: string }} */
export function render(cmd) {
  const name = templateFor(cmd);
  const fn = templates[name];
  if (!fn) throw new Error(`no template for commandType ${cmd.commandType}`);
  return { template: name, ...fn(cmd) };
}
