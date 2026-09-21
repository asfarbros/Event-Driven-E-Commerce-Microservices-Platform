import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCart, useCancelOrder } from '@/api/queries';
import type { Cart } from '@/api/types';
import { describeError, isApiError, priceChangesOf, shortItemsOf, isRetryable } from '@/api/errors';
import { Container } from '@/components/layout/Shell';
import { Card, CardSection } from '@/components/ui/Card';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Price } from '@/components/ui/Price';
import { Modal } from '@/components/ui/Overlay';
import { ErrorState, Reference } from '@/components/ui/States';
import { LineSkeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { formatPaise } from '@/lib/money';
import { isDegraded, hasUnavailable } from '@/features/cart/CartLines';
import { useCheckoutFlow } from '@/features/checkout/useCheckoutFlow';

export function CheckoutPage() {
  const cart = useCart();
  const flow = useCheckoutFlow();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [error, setError] = useState<unknown>(null);
  const cancel = useCancelOrder(flow.pendingPriceChange?.orderId ?? '');

  const blocked = isDegraded(cart.data) || hasUnavailable(cart.data);
  useEffect(() => {
    if (cart.data && cart.data.items.length === 0 && flow.phase === 'idle') navigate('/cart', { replace: true });
  }, [cart.data, flow.phase, navigate]);

  const onPay = async (c: Cart) => {
    setError(null);
    try { await flow.placeOrder(c); }
    catch (e) {
      if (isApiError(e) && e.code === 'cart_empty') { toast({ tone: 'neutral', title: 'Your cart is empty' }); navigate('/cart', { replace: true }); return; }
      setError(e);
    }
  };

  const total = cart.data?.totalInPaise;
  const payLabel = flow.phase === 'placing' ? 'Placing order…' : flow.phase === 'paying' ? 'Complete payment with Razorpay…' : flow.phase === 'redirecting' ? 'Checking your order…'
    : total != null ? `Pay ${formatPaise(total, cart.data?.currency ?? 'INR')}` : 'Pay';
  const busy = flow.phase !== 'idle';
  // If the payment window has been open a while, offer a way out: Razorpay's iframe can fail to load on a bad
  // connection and then never reports anything. Its overlay uses the maximum z-index, so the hatch is a
  // `popover` — the browser's top layer renders above any z-index and stays clickable.
  const escape = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = escape.current; if (!el) return;
    if (flow.phase !== 'paying') { try { el.hidePopover(); } catch { /* not open */ } return; }
    const t = window.setTimeout(() => { try { el.showPopover(); } catch { /* unsupported */ } }, 8000);
    return () => { window.clearTimeout(t); try { el.hidePopover(); } catch { /* not open */ } };
  }, [flow.phase]);

  return (
    <Container className="py-8 sm:py-12">
      <p className="eyebrow">Checkout</p>
      <h1 className="mt-1 text-3xl sm:text-4xl">Review and pay</h1>

      {cart.isPending ? (
        <Card className="mt-8"><CardSection><LineSkeleton lines={5} /></CardSection></Card>
      ) : cart.isError ? (
        <div className="mt-8"><ErrorState error={cart.error} onRetry={() => cart.refetch()} /></div>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_24rem] lg:items-start">
          <Card>
            <CardSection className="border-b border-border"><h2 className="text-xl">Order summary</h2></CardSection>
            <CardSection className="py-0">
              <ul className="divide-y divide-border">
                {cart.data.items.map((i) => (
                  <li key={i.productId} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0"><p className="truncate font-medium">{i.name ?? 'Item'}</p><p className="text-sm text-muted tabular">Qty {i.quantity}</p></div>
                    <Price paise={i.lineTotalInPaise} currency={i.currency} />
                  </li>
                ))}
              </ul>
            </CardSection>
            <CardSection className="flex items-baseline justify-between border-t border-border">
              <span className="font-semibold">Total</span>
              <Price paise={isDegraded(cart.data) ? null : cart.data.totalInPaise} currency={cart.data.currency ?? 'INR'} size="xl" unavailableText="Pricing unavailable" />
            </CardSection>
          </Card>

          <div className="flex flex-col gap-4 lg:sticky lg:top-24">
            <Card>
              <CardSection className="flex flex-col gap-4">
                <h2 className="text-xl">Payment</h2>
                <p className="text-sm text-muted">Payment is processed securely by Razorpay. You’ll complete UPI PIN or card OTP with Razorpay directly — we never see your card details.</p>
                <p className="text-sm text-muted">Accepted: UPI, credit and debit cards, netbanking, wallets.</p>
                {blocked && <p className="text-sm text-warning">{isDegraded(cart.data) ? 'Pricing is temporarily unavailable, so payment is paused.' : 'Remove unavailable items from your cart to continue.'}</p>}
                <div className="hidden sm:block">
                  <Button size="lg" full onClick={() => onPay(cart.data)} loading={busy} disabled={blocked || total == null}>{payLabel}</Button>
                </div>
                <ButtonLink to="/cart" variant="ghost" full>Back to cart</ButtonLink>
                <p className="text-xs text-muted">Test mode: no real money moves. Use Razorpay’s test cards or UPI.</p>
              </CardSection>
            </Card>
            {error != null && !flow.pendingPriceChange && <CheckoutError error={error} onRetry={isRetryable(error) ? () => onPay(cart.data) : undefined} cart={cart.data} />}
          </div>
        </div>
      )}

      {/* Top-layer escape hatch for a payment window that never loaded (see the effect above). */}
      <div ref={escape} popover="manual" role="status"
        className="m-0 mt-3 mx-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-surface p-3 text-sm shadow-elevated open:flex items-center justify-between gap-3">
        <span className="text-ink-2">Payment window not loading?</span>
        <Button size="sm" variant="secondary" onClick={flow.abandonWidget}>Continue to your order</Button>
      </div>

      {/* Sticky pay button on phones */}
      {cart.data && cart.data.items.length > 0 && (
        <>
          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] pt-3 backdrop-blur sm:hidden">
            <Button size="lg" full onClick={() => onPay(cart.data)} loading={busy} disabled={blocked || total == null}>{payLabel}</Button>
          </div>
          <div className="h-20 sm:hidden" aria-hidden="true" />
        </>
      )}

      {/* Price changed (policy "proceed"): the order exists at the new price; confirm before paying, or cancel it. */}
      <Modal open={!!flow.pendingPriceChange} onClose={() => {}} title="A price has changed"
        footer={<>
          <Button variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate('price changed — customer declined', { onSettled: () => { flow.dismissPriceChange(); navigate('/cart'); } })}>Back to cart</Button>
          <Button onClick={() => flow.confirmPriceChange()}>Pay {flow.pendingPriceChange ? formatPaise(flow.pendingPriceChange.totalInPaise, flow.pendingPriceChange.currency) : ''}</Button>
        </>}>
        <p className="text-muted">Since you added these to your cart, the store updated a price. Please confirm before paying.</p>
        <ul className="mt-4 divide-y divide-border">
          {flow.pendingPriceChange?.priceChanges?.map((c) => (
            <li key={c.productId} className="flex items-center justify-between gap-4 py-2">
              <span className="font-medium">{c.name ?? flow.pendingPriceChange?.items.find((i) => i.productId === c.productId)?.name ?? c.productId}</span>
              <span className="text-sm tabular"><s className="text-muted">{formatPaise(c.previousUnitPriceInPaise ?? c.oldUnitPriceInPaise ?? null)}</s> → <strong>{formatPaise(c.currentUnitPriceInPaise ?? c.newUnitPriceInPaise ?? null)}</strong></span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm">New total: <strong className="tabular">{flow.pendingPriceChange ? formatPaise(flow.pendingPriceChange.totalInPaise, flow.pendingPriceChange.currency) : ''}</strong></p>
      </Modal>
    </Container>
  );
}

/** Maps the checkout-specific errors: names the products for out-of-stock, shows old/new prices for a rejected price change. */
function CheckoutError({ error, onRetry, cart }: { error: unknown; onRetry?: () => void; cart: Cart }) {
  const short = shortItemsOf(error);
  const changes = priceChangesOf(error);
  const nameOf = (id: string) => cart.items.find((i) => i.productId === id)?.name ?? 'An item';
  if (short.length) {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
        <p className="text-lg font-semibold">Not enough stock for some items</p>
        <p className="text-muted">Nothing has been charged. Adjust the quantities and try again:</p>
        <ul className="divide-y divide-border rounded-md border border-border">
          {short.map((s) => (
            <li key={s.productId} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
              <span className="font-medium">{nameOf(s.productId)}</span>
              <span className="text-muted tabular">{s.available === 0 ? 'Out of stock' : `Only ${s.available} available (you asked for ${s.requested})`}</span>
            </li>
          ))}
        </ul>
        <ButtonLink to="/cart" variant="secondary">Adjust cart</ButtonLink>
        <Reference error={error} />
      </div>
    );
  }
  if (changes.length) {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
        <p className="text-lg font-semibold">A price has changed</p>
        <ul className="divide-y divide-border rounded-md border border-border">
          {changes.map((c) => (
            <li key={c.productId} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
              <span className="font-medium">{c.name ?? nameOf(c.productId)}</span>
              <span className="tabular"><s className="text-muted">{formatPaise(c.previousUnitPriceInPaise ?? c.oldUnitPriceInPaise ?? null)}</s> → <strong>{formatPaise(c.currentUnitPriceInPaise ?? c.newUnitPriceInPaise ?? null)}</strong></span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">Review your cart with the new prices, then pay.</p>
        <ButtonLink to="/cart" variant="secondary">Review cart</ButtonLink>
        <Reference error={error} />
      </div>
    );
  }
  const d = describeError(error);
  return <ErrorState error={error} onRetry={onRetry} title={d.title} compact />;
}
