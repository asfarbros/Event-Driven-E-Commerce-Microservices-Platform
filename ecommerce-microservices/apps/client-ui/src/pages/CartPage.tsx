import { useState } from 'react';
import { useCart, useCartMutations } from '@/api/queries';
import { describeError } from '@/api/errors';
import { Container } from '@/components/layout/Shell';
import { Card, CardSection } from '@/components/ui/Card';
import { Button, ButtonLink } from '@/components/ui/Button';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { LineSkeleton } from '@/components/ui/Skeleton';
import { Modal } from '@/components/ui/Overlay';
import { useToast } from '@/components/ui/Toast';
import { CartLines, CartTotal, hasUnavailable, isDegraded } from '@/features/cart/CartLines';

export function CartPage() {
  const cart = useCart();
  const { clear } = useCartMutations();
  const { toast } = useToast();
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <Container className="py-8 sm:py-12">
      <p className="eyebrow">Cart</p>
      <h1 className="mt-1 text-3xl sm:text-4xl">Your cart</h1>

      <div className="mt-8">
        {cart.isPending ? (
          <Card><CardSection><LineSkeleton lines={5} /></CardSection></Card>
        ) : cart.isError ? (
          <ErrorState error={cart.error} onRetry={() => cart.refetch()} />
        ) : cart.data.items.length === 0 ? (
          <EmptyState title="Your cart is empty" description="Find something you like in the shop." action={<ButtonLink to="/">Continue shopping</ButtonLink>} />
        ) : (
          <CartBody cart={cart.data} onClear={() => setConfirmClear(true)} refreshing={cart.isFetching} onRefresh={() => cart.refetch()} />
        )}
      </div>

      <Modal open={confirmClear} onClose={() => setConfirmClear(false)} title="Clear your cart?"
        footer={<>
          <Button variant="secondary" onClick={() => setConfirmClear(false)}>Keep items</Button>
          <Button variant="danger" loading={clear.isPending} onClick={() => clear.mutate(undefined, {
            onSuccess: () => { setConfirmClear(false); toast({ tone: 'neutral', title: 'Cart cleared' }); },
            onError: (e) => { const d = describeError(e); toast({ tone: 'danger', title: d.title, description: d.message }); },
          })}>Clear cart</Button>
        </>}>
        <p className="text-muted">This removes every item. You can add them again any time.</p>
      </Modal>
    </Container>
  );
}

function CartBody({ cart, onClear, refreshing, onRefresh }:
  { cart: NonNullable<ReturnType<typeof useCart>['data']>; onClear: () => void; refreshing: boolean; onRefresh: () => void }) {
  const degraded = isDegraded(cart);
  const unavailable = hasUnavailable(cart);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
      <Card>
        <CardSection className="flex items-center justify-between border-b border-border">
          <p className="text-sm text-muted tabular">{cart.totalQuantity} item{cart.totalQuantity === 1 ? '' : 's'}</p>
          <button type="button" onClick={onClear} className="text-sm font-medium text-muted underline-offset-2 hover:text-danger hover:underline">Clear cart</button>
        </CardSection>
        <CardSection className="py-0">
          {/* DEGRADED (Catalog unavailable): items are shown, money is not, checkout is paused — never ₹0. */}
          {degraded && (
            <div role="status" className="my-4 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-ink-2">
              <p className="font-semibold text-warning">Pricing is temporarily unavailable</p>
              <p className="mt-0.5">Your items are safe. We can’t show prices or take payment until the catalogue is back — usually a few moments.</p>
              <Button variant="secondary" size="sm" className="mt-2" onClick={onRefresh} loading={refreshing}>Check again</Button>
            </div>
          )}
          <CartLines cart={cart} />
        </CardSection>
      </Card>

      <Card className="lg:sticky lg:top-24">
        <CardSection className="flex flex-col gap-4">
          <h2 className="text-xl">Summary</h2>
          <CartTotal cart={cart} />
          <p className="text-xs text-muted">Taxes included. The final amount is confirmed by the store at checkout.</p>
          {unavailable && !degraded && <p className="text-sm text-danger">Remove the unavailable items to continue.</p>}
          <ButtonLink to="/checkout" size="lg" full aria-disabled={degraded || unavailable || undefined}
            className={degraded || unavailable ? 'pointer-events-none opacity-50' : undefined}
            onClick={(e) => { if (degraded || unavailable) e.preventDefault(); }}>
            {degraded ? 'Checkout paused' : 'Go to checkout'}
          </ButtonLink>
          <ButtonLink to="/" variant="ghost" full>Continue shopping</ButtonLink>
        </CardSection>
      </Card>
    </div>
  );
}
