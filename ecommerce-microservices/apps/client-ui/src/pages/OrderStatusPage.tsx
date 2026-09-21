import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useCancelOrder, useOrder } from '@/api/queries';
import { isApiError, describeError } from '@/api/errors';
import { Container } from '@/components/layout/Shell';
import { Card, CardSection } from '@/components/ui/Card';
import { Button, ButtonLink } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/Badge';
import { Price } from '@/components/ui/Price';
import { Modal } from '@/components/ui/Overlay';
import { ErrorState, Reference } from '@/components/ui/States';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { STATUS_META, isTerminal, type OrderStatus } from '@/lib/status';
import { StatusTimeline } from '@/features/orders/StatusTimeline';
import { useOrderStatusPolling } from '@/features/orders/useOrderStatusPolling';
import { useCheckoutFlow } from '@/features/checkout/useCheckoutFlow';
import { NotFoundPage } from './NotFoundPage';

const headline: Record<OrderStatus, string> = {
  PENDING: 'Placing your order…', RESERVED: 'Reserving your items…', AWAITING_PAYMENT: 'Confirming your payment…',
  CONFIRMED: 'Your order is confirmed', FAILED: 'This order was not completed', CANCELLED: 'This order was cancelled',
};

/**
 * The live status page — the centrepiece. It trusts only the server: after
 * checkout the browser lands here with `?outcome=` from the Razorpay widget,
 * which is used ONLY to word the interim message; the state shown is whatever
 * polling returns (see features/checkout/useCheckoutFlow.ts).
 */
export function OrderStatusPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const outcome = params.get('outcome');
  const polling = useOrderStatusPolling(id);
  const order = useOrder(id);
  const flow = useCheckoutFlow();
  const cancel = useCancelOrder(id);
  const { toast } = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const status = polling.status ?? order.data?.status;
  const live = !!status && !isTerminal(status) && !polling.timedOut;

  // Announce state changes to screen readers without re-reading the whole page.
  const announce = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (status && announce.current) announce.current.textContent = `Order status: ${STATUS_META[status].label}. ${STATUS_META[status].blurb}`; }, [status]);

  if (order.isError && isApiError(order.error) && order.error.status === 404) {
    return <NotFoundPage title="We couldn’t find that order" description="It may belong to a different account, or the link may be incorrect." requestId={order.error.requestId} />;
  }

  const interim = status === 'AWAITING_PAYMENT'
    ? outcome === 'dismissed' ? 'The payment window was closed before finishing. Your items are still reserved for a short while — you can complete the payment or cancel.'
      : outcome === 'failed' ? 'Razorpay reported that the payment did not go through. We are checking with the payment provider before updating your order.'
      : outcome === 'script_failed' ? 'The payment window could not be opened. Check your connection and try again — your items are reserved for a short while.'
      : 'Razorpay is confirming your payment with the bank. This usually takes a few seconds.'
    : status ? STATUS_META[status].blurb : '';

  return (
    <Container className="py-8 sm:py-12">
      <p ref={announce} className="sr-only" aria-live="polite" aria-atomic="true" />
      <div className="mx-auto max-w-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">Order {id.slice(0, 8).toUpperCase()}</p>
          {status && <StatusPill status={status} live={live} />}
        </div>
        <h1 className="mt-2 text-3xl sm:text-4xl" aria-live="off">
          {!status ? 'Loading your order…'
            : status === 'AWAITING_PAYMENT' && (outcome === 'dismissed' || outcome === 'script_failed') ? 'Payment not completed yet'
            : status === 'AWAITING_PAYMENT' && outcome === 'failed' ? 'Checking your payment…'
            : headline[status]}
        </h1>
        <p className="mt-2 max-w-prose text-muted">{interim}</p>

        {polling.timedOut && !isTerminal(status) && (
          <div role="status" className="mt-5 flex flex-col items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-4">
            <p className="font-semibold text-warning">This is taking longer than expected</p>
            <p className="text-sm text-ink-2">We’ve stopped checking automatically. Your order is safe; if you paid, it will be confirmed as soon as the payment provider reports it — you can also come back to this page later.</p>
            <Button variant="secondary" size="sm" onClick={() => polling.refresh()}>Check again</Button>
          </div>
        )}
        {polling.error && !polling.status && <div className="mt-5"><ErrorState error={polling.error} onRetry={() => polling.refresh()} compact /></div>}

        <Card className="mt-8">
          <CardSection>
            {order.isPending ? (
              <div className="flex flex-col gap-5">{[0, 1, 2, 3].map((i) => <div key={i} className="flex gap-4"><Skeleton className="size-7 rounded-full" /><div className="flex-1"><Skeleton className="h-4 w-40" /><Skeleton className="mt-2 h-3 w-64" /></div></div>)}</div>
            ) : order.isError ? (
              <ErrorState error={order.error} onRetry={() => order.refetch()} compact />
            ) : (
              <StatusTimeline status={status ?? order.data.status} history={order.data.history} live={live} />
            )}
          </CardSection>
        </Card>

        {order.data && (
          <Card className="mt-4">
            <CardSection className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-4"><span className="text-sm text-muted">{order.data.totalQuantity} item{order.data.totalQuantity === 1 ? '' : 's'}</span><Price paise={order.data.totalInPaise} currency={order.data.currency} size="lg" /></div>
              <div className="flex flex-wrap gap-2 pt-1">
                {status === 'AWAITING_PAYMENT' && order.data.payment && (
                  <Button onClick={() => flow.pay({ orderId: order.data!.orderId, payment: order.data!.payment! })} loading={flow.phase !== 'idle'}>Complete payment</Button>
                )}
                {status === 'AWAITING_PAYMENT' && <Button variant="secondary" onClick={() => setConfirmCancel(true)}>Cancel order</Button>}
                {status === 'CONFIRMED' && <Button variant="secondary" onClick={() => setConfirmCancel(true)}>Cancel and refund</Button>}
                <ButtonLink to={`/orders/${id}`} variant="ghost">Order details</ButtonLink>
                {isTerminal(status) && <ButtonLink to="/" variant="ghost">Continue shopping</ButtonLink>}
              </div>
              <Reference requestId={order.data.history[0]?.requestId} />
              <p className="text-xs text-muted">Order id <span className="tabular select-all">{id}</span> · <Link to="/orders" className="text-accent hover:underline">All orders</Link></p>
            </CardSection>
          </Card>
        )}
      </div>

      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title={status === 'CONFIRMED' ? 'Cancel this order and refund?' : 'Cancel this order?'}
        footer={<>
          <Button variant="secondary" onClick={() => setConfirmCancel(false)}>Keep order</Button>
          <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate('cancelled from order status page', {
            onSuccess: (r) => { setConfirmCancel(false); polling.refresh(); toast({ tone: 'neutral', title: r.cancelled ? 'Order cancelled' : 'Order was already closed', description: r.paymentStatus === 'REFUND_PENDING' ? 'Your refund has been requested.' : undefined }); },
            onError: (e) => { const d = describeError(e); toast({ tone: 'danger', title: d.title, description: d.message }); },
          })}>{status === 'CONFIRMED' ? 'Cancel and refund' : 'Cancel order'}</Button>
        </>}>
        <p className="text-muted">{status === 'CONFIRMED' ? 'The full amount will be refunded to your original payment method within 5–7 working days, and the items go back to stock.' : 'Your reserved items will be released. Nothing has been charged.'}</p>
      </Modal>
    </Container>
  );
}
