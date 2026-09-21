import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '@clerk/clerk-react';
import { useCartMutations, useProduct, useStock } from '@/api/queries';
import { isApiError, describeError } from '@/api/errors';
import { Container } from '@/components/layout/Shell';
import { ProductImage, ErrorState } from '@/components/ui/States';
import { Price } from '@/components/ui/Price';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { QuantityStepper } from '@/components/ui/QuantityStepper';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { NotFoundPage } from './NotFoundPage';
import { MAX_QTY } from '@/features/cart/CartLines';

const pretty = (slug: string) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' & ');

export function ProductDetailPage() {
  const { id = '' } = useParams();
  const product = useProduct(id);
  const { isSignedIn } = useAuth();
  const stock = useStock(id, !!isSignedIn && !!product.data);
  const { add } = useCartMutations();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [qty, setQty] = useState(1);

  if (product.isPending) {
    // Same shape as the loaded page (breadcrumb row + 2-column grid) so the swap causes no layout shift.
    return (
      <Container className="py-6 sm:py-10">
        <Skeleton className="mb-4 h-5 w-64" />
        <div className="grid gap-8 lg:grid-cols-2 lg:gap-14">
          <Skeleton className="aspect-[4/5] w-full rounded-lg" />
          <div className="flex flex-col gap-5 lg:py-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-10 w-3/4" /><Skeleton className="h-7 w-32" /><Skeleton className="h-6 w-40" /><Skeleton className="h-24 w-full" /><Skeleton className="hidden h-12 w-64 sm:block" /></div>
        </div>
      </Container>
    );
  }
  if (product.isError) {
    if (isApiError(product.error) && product.error.status === 404) {
      return <NotFoundPage title="We couldn’t find that product" description="It may have been removed from the shop." requestId={product.error.requestId} />;
    }
    return <Container className="py-8"><ErrorState error={product.error} onRetry={() => product.refetch()} /></Container>;
  }
  const p = product.data;
  const soldOut = stock.data ? stock.data.available <= 0 : false;
  const inactive = !p.isActive;
  const maxQty = stock.data ? Math.max(1, Math.min(MAX_QTY, stock.data.available)) : MAX_QTY;

  const addToCart = () => {
    if (!isSignedIn) { navigate(`/sign-in?redirect_url=${encodeURIComponent(`/products/${p.id}`)}`); return; }
    add.mutate({ productId: p.id, quantity: qty }, {
      onSuccess: () => toast({ tone: 'success', title: 'Added to cart', description: `${p.name} × ${qty}`, action: { label: 'View cart', onClick: () => navigate('/cart') } }),
      onError: (e) => { const d = describeError(e); toast({ tone: 'danger', title: d.title, description: d.message }); },
    });
  };
  const cta = inactive ? 'Currently unavailable' : soldOut ? 'Out of stock' : isSignedIn ? 'Add to cart' : 'Sign in to add to cart';
  const disabled = inactive || soldOut;

  return (
    <Container className="py-6 sm:py-10">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li><Link to="/" className="hover:text-ink">Shop</Link></li><li aria-hidden="true">/</li>
          <li><Link to={`/?category=${p.category}`} className="hover:text-ink">{pretty(p.category)}</Link></li><li aria-hidden="true">/</li>
          <li aria-current="page" className="text-ink">{p.name}</li>
        </ol>
      </nav>

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-14">
        <ProductImage src={p.imageUrl} alt={p.name} priority sizes="(min-width: 1024px) 50vw, 100vw" />

        <div className="flex flex-col gap-5 lg:py-2">
          <div>
            <p className="eyebrow">{pretty(p.category)}</p>
            <h1 className="mt-1 text-3xl sm:text-4xl">{p.name}</h1>
            <p className="mt-3"><Price paise={p.priceInPaise} currency={p.currency} size="lg" /> <span className="text-sm text-muted">incl. taxes</span></p>
          </div>

          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            {inactive ? <Badge tone="danger">Currently unavailable</Badge>
              : !isSignedIn ? <Badge>Sign in to see stock</Badge>
              : stock.isPending ? <Skeleton className="h-5 w-24" />
              : stock.isError ? <Badge>Stock unknown right now</Badge>
              : soldOut ? <Badge tone="danger">Out of stock</Badge>
              : stock.data.available <= 5 ? <Badge tone="warning">Only {stock.data.available} left</Badge>
              : <Badge tone="success">In stock</Badge>}
            <span className="text-xs text-muted tabular">SKU {p.sku}</span>
          </div>

          {p.description && <p className="max-w-prose text-base leading-relaxed text-ink-2">{p.description}</p>}

          <div className="hidden items-center gap-3 sm:flex">
            <QuantityStepper value={qty} onChange={setQty} max={maxQty} disabled={disabled} />
            <Button size="lg" onClick={addToCart} disabled={disabled} loading={add.isPending} className="min-w-48">{cta}</Button>
          </div>

          <ul className="mt-2 grid gap-2 text-sm text-muted sm:grid-cols-2">
            <li>Secure payment by Razorpay — UPI, cards, netbanking</li>
            <li>Prices are set by the store and checked again at checkout</li>
          </ul>
        </div>
      </div>

      {/* Sticky bottom bar on phones: price, quantity and the one action, always in reach. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] pt-3 backdrop-blur sm:hidden">
        <div className="flex items-center gap-3">
          <QuantityStepper value={qty} onChange={setQty} max={maxQty} disabled={disabled} size="sm" />
          <Button onClick={addToCart} disabled={disabled} loading={add.isPending} className="flex-1">{cta}</Button>
        </div>
      </div>
      <div className="h-20 sm:hidden" aria-hidden="true" />
    </Container>
  );
}
