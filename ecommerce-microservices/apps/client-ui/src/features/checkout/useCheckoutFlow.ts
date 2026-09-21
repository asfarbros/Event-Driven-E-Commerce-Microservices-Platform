import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useUser } from '@clerk/clerk-react';
import { useQueryClient } from '@tanstack/react-query';
import { keys, useCheckout } from '@/api/queries';
import type { Cart, CheckoutResult } from '@/api/types';
import { config } from '@/config/env';
import { idempotencyKeyFor, resetIdempotencyKey } from '@/lib/idempotency';
import { openRazorpayCheckout, type RazorpayOutcome, type RazorpaySession } from '@/lib/razorpay';
import { formatPaise } from '@/lib/money';

/**
 * THE CHECKOUT FLOW — the India/RBI shape: a synchronous, user-present zone
 * (place order → pay with Razorpay), then an asynchronous zone the browser
 * only WATCHES (webhook → Kafka saga → CONFIRMED).
 *
 *  1. Pay → POST /api/orders/ with a stable Idempotency-Key for this attempt.
 *     The button is disabled at once, but the key is the real double-submit
 *     protection: a second request returns the same order, never a second one.
 *  2. The backend answers with our orderId and what Razorpay needs (razorpay
 *     order id, key id, amount, currency) — amounts come from the SERVER.
 *  3. Open Razorpay's widget with those values. OTP / UPI PIN happen between
 *     the customer and Razorpay; we are not involved.
 *  4. BROWSER CALLBACK IS NOT TRUTH. Whatever the widget reports — success,
 *     failure, dismissal, even a script that failed to load — we navigate to
 *     the order's status page and POLL the backend. The backend learns the real
 *     outcome from Razorpay's signed webhook; the browser callback can be
 *     lost (closed tab, dropped connection) or arrive before the webhook. An
 *     order is shown as confirmed only when the server says CONFIRMED.
 */
export type CheckoutPhase = 'idle' | 'placing' | 'paying' | 'redirecting';

export function useCheckoutFlow() {
  const checkout = useCheckout();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useUser();
  const [phase, setPhase] = useState<CheckoutPhase>('idle');
  const [pendingPriceChange, setPendingPriceChange] = useState<CheckoutResult | null>(null);
  const inFlight = useRef(false);
  const session = useRef<RazorpaySession | null>(null);
  const activeOrder = useRef<string | null>(null);

  const goToStatus = useCallback((orderId: string, outcome: RazorpayOutcome['kind']) => {
    setPhase('redirecting');
    resetIdempotencyKey();
    qc.invalidateQueries({ queryKey: keys.cart });
    navigate(`/orders/${orderId}/status?from=checkout&outcome=${outcome}`, { replace: true });
  }, [navigate, qc]);

  /** Step 3–4: open the widget for an existing (AWAITING_PAYMENT) order, then hand over to polling. Also used to "pay again". */
  const pay = useCallback(async (result: Pick<CheckoutResult, 'orderId' | 'payment'>) => {
    setPhase('paying');
    activeOrder.current = result.orderId;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
    session.current = await openRazorpayCheckout({
      keyId: result.payment.razorpayKeyId || config.razorpayKeyId,
      amountInPaise: result.payment.amountInPaise,
      currency: result.payment.currency,
      razorpayOrderId: result.payment.razorpayOrderId,
      ourOrderId: result.orderId,
      description: `Order ${result.orderId.slice(0, 8).toUpperCase()} · ${formatPaise(result.payment.amountInPaise, result.payment.currency)}`,
      customer: { name: user?.fullName ?? undefined, email: user?.primaryEmailAddress?.emailAddress },
      accentColor: accent,
    });
    // If Razorpay's iframe never loads (network), it never takes focus and never handles Escape — so the
    // parent window still sees the key. Escape then closes the dead overlay; a live widget handles Escape itself.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') session.current?.close(); };
    window.addEventListener('keydown', onKey);
    let outcome: RazorpayOutcome;
    try { outcome = await session.current.outcome; } finally { window.removeEventListener('keydown', onKey); session.current = null; }
    goToStatus(result.orderId, outcome.kind);
  }, [goToStatus, user]);

  /**
   * Escape hatch: the widget's iframe never loaded (network). Close it and continue to the order's status
   * page with a FULL navigation — Razorpay's script keeps a handle to the dead iframe, and only a fresh
   * document lets "Complete payment" open a working widget again.
   */
  const abandonWidget = useCallback(() => {
    const id = activeOrder.current;
    session.current?.close();
    if (id) { resetIdempotencyKey(); window.location.assign(`/orders/${id}/status?from=checkout&outcome=dismissed`); }
  }, []);

  /** Step 1–2: place the order. Resolves when the flow has moved on (paying / modal / error). */
  const placeOrder = useCallback(async (cart: Cart) => {
    if (inFlight.current) return;                 // belt: no concurrent submits from one page
    inFlight.current = true;
    setPhase('placing');
    try {
      const result = await checkout.mutateAsync({ idempotencyKey: idempotencyKeyFor(cart) });
      if (result.priceChanges && result.priceChanges.length > 0) {
        // Policy "proceed": the order exists at the fresh price — show old vs new and require confirmation before paying.
        setPendingPriceChange(result);
        setPhase('idle');
        return;
      }
      await pay(result);
    } catch (err) {
      setPhase('idle');
      throw err;                                  // the page maps it (out of stock, cart empty, 503 …)
    } finally {
      inFlight.current = false;
    }
  }, [checkout, pay]);

  const confirmPriceChange = useCallback(async () => {
    const r = pendingPriceChange; if (!r) return;
    setPendingPriceChange(null);
    await pay(r);
  }, [pendingPriceChange, pay]);

  return { phase, placeOrder, pay, abandonWidget, pendingPriceChange, confirmPriceChange, dismissPriceChange: () => setPendingPriceChange(null), error: checkout.error, reset: checkout.reset };
}
