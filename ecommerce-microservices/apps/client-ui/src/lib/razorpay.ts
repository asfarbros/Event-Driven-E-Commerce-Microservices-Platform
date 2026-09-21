/**
 * Razorpay Checkout — loads the official script once and opens the widget
 * with the values the SERVER returned (order id, key id, amount, currency).
 * The browser never chooses the amount.
 *
 * The widget's outcome is reported back as a plain result and nothing more:
 * the browser callback is NOT the source of truth for an order (see
 * features/checkout/useCheckoutFlow.ts) — the backend learns the real outcome
 * from Razorpay's signed webhook.
 */
const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

export type RazorpayOutcome =
  | { kind: 'success'; paymentId: string; orderId: string; signature: string }
  | { kind: 'failed'; code?: string; description?: string; reason?: string }
  | { kind: 'dismissed' }
  | { kind: 'script_failed' };

interface RazorpayOptions {
  key: string; amount: number; currency: string; order_id: string; name: string; description?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string; backdrop_color?: string };
  modal?: { ondismiss?: () => void; escape?: boolean; confirm_close?: boolean };
  retry?: { enabled: boolean };
  handler: (r: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => void;
}
interface RazorpayInstance { open: () => void; on: (event: 'payment.failed', cb: (r: { error: { code?: string; description?: string; reason?: string } }) => void) => void; close: () => void }
declare global { interface Window { Razorpay?: new (o: RazorpayOptions) => RazorpayInstance } }

let loading: Promise<boolean> | null = null;
export function loadRazorpay(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC; s.async = true;
    s.onload = () => resolve(!!window.Razorpay);
    s.onerror = () => { loading = null; resolve(false); };
    document.head.appendChild(s);
  });
  return loading;
}

export interface OpenCheckoutInput {
  keyId: string; amountInPaise: number; currency: string; razorpayOrderId: string; ourOrderId: string;
  customer?: { name?: string; email?: string }; accentColor: string; description: string;
}

/**
 * Opens the widget. `outcome` resolves exactly once with what the user did;
 * `close()` is the escape hatch for a widget whose iframe never loaded (a
 * network failure between the browser and Razorpay): it tears the overlay
 * down and resolves as `dismissed`, so the app can hand over to the status page.
 */
export interface RazorpaySession { outcome: Promise<RazorpayOutcome>; close: () => void }

export async function openRazorpayCheckout(input: OpenCheckoutInput): Promise<RazorpaySession> {
  const ok = await loadRazorpay();
  if (!ok || !window.Razorpay) return { outcome: Promise.resolve({ kind: 'script_failed' }), close: () => {} };
  let settled = false;
  let resolveOutcome!: (o: RazorpayOutcome) => void;
  const outcome = new Promise<RazorpayOutcome>((resolve) => { resolveOutcome = resolve; });
  const done = (o: RazorpayOutcome) => { if (!settled) { settled = true; resolveOutcome(o); } };
  const rzp = new window.Razorpay!({
      key: input.keyId,
      amount: input.amountInPaise,          // from the server, in paise
      currency: input.currency,
      order_id: input.razorpayOrderId,
      name: 'OrderFlow',
      description: input.description,
      prefill: input.customer,
      notes: { orderId: input.ourOrderId },
      theme: { color: input.accentColor },
      retry: { enabled: false },            // a failed attempt comes back to us; we show the real status instead
      modal: { ondismiss: () => done({ kind: 'dismissed' }), escape: true, confirm_close: false },
      handler: (r) => done({ kind: 'success', paymentId: r.razorpay_payment_id, orderId: r.razorpay_order_id, signature: r.razorpay_signature }),
    });
  rzp.on('payment.failed', (r) => done({ kind: 'failed', code: r.error?.code, description: r.error?.description, reason: r.error?.reason }));
  rzp.open();
  const close = () => {
    try { rzp.close(); } catch { /* already closed */ }
    // rzp.close() talks to the iframe; if the iframe never loaded nothing answers and the overlay stays.
    // Remove the container ourselves so the page is usable again, then report the dismissal.
    window.setTimeout(() => { document.querySelectorAll('.razorpay-container').forEach((el) => el.remove()); document.body.style.overflow = ''; }, 300);
    done({ kind: 'dismissed' });
  };
  return { outcome, close };
}
