import { Link, useSearchParams } from 'react-router';
import { useOrders } from '@/api/queries';
import { Container } from '@/components/layout/Shell';
import { Card } from '@/components/ui/Card';
import { Button, ButtonLink } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/Badge';
import { Price } from '@/components/ui/Price';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Skeleton } from '@/components/ui/Skeleton';
import { isTerminal } from '@/lib/status';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Order history — the caller's own orders only (the Gateway's identity, never a client-sent user id). */
export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') || 1));
  const orders = useOrders(page);

  return (
    <Container className="py-8 sm:py-12">
      <p className="eyebrow">Account</p>
      <h1 className="mt-1 text-3xl sm:text-4xl">Your orders</h1>
      <div className="mt-8">
        {orders.isPending ? (
          <div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}</div>
        ) : orders.isError ? (
          <ErrorState error={orders.error} onRetry={() => orders.refetch()} />
        ) : orders.data.items.length === 0 ? (
          <EmptyState title="No orders yet" description="Your orders will appear here as soon as you place one." action={<ButtonLink to="/">Start shopping</ButtonLink>} />
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {orders.data.items.map((o) => (
                <li key={o.orderId}>
                  <Card className="transition-colors duration-(--duration-fast) hover:bg-surface-2/60">
                    <Link to={isTerminal(o.status) ? `/orders/${o.orderId}` : `/orders/${o.orderId}/status`} className="grid gap-3 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6 sm:p-5">
                      <div className="min-w-0">
                        <p className="font-display text-lg text-ink">Order {o.orderId.slice(0, 8).toUpperCase()}</p>
                        <p className="mt-0.5 truncate text-sm text-muted">{o.items.map((i) => `${i.name} × ${i.quantity}`).join(', ')}</p>
                        <p className="mt-0.5 text-xs text-muted tabular">{when(o.createdAt)}</p>
                      </div>
                      <StatusPill status={o.status} live={!isTerminal(o.status)} />
                      <Price paise={o.totalInPaise} currency={o.currency} size="lg" className="sm:text-right" />
                    </Link>
                  </Card>
                </li>
              ))}
            </ul>
            {orders.data.pagination.totalPages > 1 && (
              <nav aria-label="Pagination" className="mt-8 flex items-center justify-center gap-3">
                <Button variant="secondary" size="sm" disabled={!orders.data.pagination.hasPrev} onClick={() => setParams({ page: String(page - 1) })}>Previous</Button>
                <span className="text-sm text-muted tabular">Page {orders.data.pagination.page} of {orders.data.pagination.totalPages}</span>
                <Button variant="secondary" size="sm" disabled={!orders.data.pagination.hasNext} onClick={() => setParams({ page: String(page + 1) })}>Next</Button>
              </nav>
            )}
          </>
        )}
      </div>
    </Container>
  );
}
