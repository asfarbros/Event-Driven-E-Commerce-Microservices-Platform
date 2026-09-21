import { Link, useParams } from 'react-router';
import { useOrder } from '@/api/queries';
import { isApiError } from '@/api/errors';
import { Container } from '@/components/layout/Shell';
import { Card, CardSection } from '@/components/ui/Card';
import { ButtonLink } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/Badge';
import { Price } from '@/components/ui/Price';
import { ErrorState, Reference } from '@/components/ui/States';
import { LineSkeleton } from '@/components/ui/Skeleton';
import { PAYMENT_META, isTerminal } from '@/lib/status';
import { StatusTimeline } from '@/features/orders/StatusTimeline';
import { NotFoundPage } from './NotFoundPage';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const order = useOrder(id);

  if (order.isPending) return <Container className="py-10"><Card><CardSection><LineSkeleton lines={6} /></CardSection></Card></Container>;
  if (order.isError) {
    if (isApiError(order.error) && order.error.status === 404) {
      // The backend answers 404 for another user's order exactly as for a missing id — nothing to probe.
      return <NotFoundPage title="We couldn’t find that order" description="It may belong to a different account, or the link may be incorrect." requestId={order.error.requestId} />;
    }
    return <Container className="py-10"><ErrorState error={order.error} onRetry={() => order.refetch()} /></Container>;
  }
  const o = order.data;

  return (
    <Container className="py-8 sm:py-12">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted"><Link to="/orders" className="hover:text-ink">Your orders</Link> <span aria-hidden="true">/</span> <span className="text-ink">Order {o.orderId.slice(0, 8).toUpperCase()}</span></nav>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Placed {when(o.createdAt)}</p>
          <h1 className="mt-1 text-3xl sm:text-4xl">Order {o.orderId.slice(0, 8).toUpperCase()}</h1>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill status={o.status} live={!isTerminal(o.status)} />
          {!isTerminal(o.status) && <ButtonLink to={`/orders/${o.orderId}/status`} size="sm">Live status</ButtonLink>}
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_24rem] lg:items-start">
        <div className="flex flex-col gap-6">
          <Card>
            <CardSection className="border-b border-border"><h2 className="text-xl">Items</h2></CardSection>
            <CardSection className="py-0">
              <ul className="divide-y divide-border">
                {o.items.map((i) => (
                  <li key={i.productId} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <Link to={`/products/${i.productId}`} className="block truncate font-medium hover:text-accent">{i.name}</Link>
                      <p className="text-sm text-muted tabular">Qty {i.quantity} · <Price paise={i.unitPriceInPaise} currency={i.currency} size="sm" muted className="font-normal" /> each</p>
                    </div>
                    <Price paise={i.lineTotalInPaise} currency={i.currency} />
                  </li>
                ))}
              </ul>
            </CardSection>
            <CardSection className="flex items-baseline justify-between border-t border-border"><span className="font-semibold">Total</span><Price paise={o.totalInPaise} currency={o.currency} size="lg" /></CardSection>
          </Card>

          <Card>
            <CardSection className="border-b border-border"><h2 className="text-xl">Progress</h2></CardSection>
            <CardSection><StatusTimeline status={o.status} history={o.history} live={!isTerminal(o.status)} /></CardSection>
          </Card>
        </div>

        <Card className="lg:sticky lg:top-24">
          <CardSection className="flex flex-col gap-3 text-sm">
            <h2 className="text-xl">Details</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted">Payment</dt><dd>{PAYMENT_META[o.paymentStatus] ?? o.paymentStatus}</dd>
              <dt className="text-muted">Amount</dt><dd><Price paise={o.totalInPaise} currency={o.currency} size="sm" /></dd>
              {o.payment && <><dt className="text-muted">Provider ref</dt><dd className="tabular break-all">{o.payment.razorpayOrderId}</dd></>}
              {o.failureReason && <><dt className="text-muted">Note</dt><dd>{o.failureReason}</dd></>}
              <dt className="text-muted">Updated</dt><dd className="tabular">{when(o.updatedAt)}</dd>
              <dt className="text-muted">Order id</dt><dd className="tabular break-all select-all">{o.orderId}</dd>
            </dl>
            <Reference requestId={o.history[0]?.requestId} className="pt-2" />
          </CardSection>
        </Card>
      </div>
    </Container>
  );
}
