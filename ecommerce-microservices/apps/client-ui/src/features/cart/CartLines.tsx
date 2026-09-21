import { Link } from 'react-router';
import type { Cart, CartItem } from '@/api/types';
import { useCartMutations } from '@/api/queries';
import { useToast } from '@/components/ui/Toast';
import { describeError } from '@/api/errors';
import { QuantityStepper } from '@/components/ui/QuantityStepper';
import { Price } from '@/components/ui/Price';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

export const MAX_QTY = 10;

/** True when the server could not price the cart (Catalog down): show items, hide money, block checkout. */
export function isDegraded(cart: Cart | undefined): boolean {
  return !!cart && (cart.degraded === true || cart.pricing?.status === 'unavailable');
}
/** True when at least one line can’t be bought as-is (not found / inactive). */
export function hasUnavailable(cart: Cart | undefined): boolean {
  return !!cart && cart.items.some((i) => i.priceStatus === 'not_found' || i.priceStatus === 'inactive');
}

function lineNote(item: CartItem, degraded: boolean): { text: string; tone: 'warning' | 'danger' } | null {
  if (item.priceStatus === 'not_found') return { text: 'No longer available', tone: 'danger' };
  if (item.priceStatus === 'inactive') return { text: 'Currently unavailable', tone: 'danger' };
  if (degraded || item.priceStatus !== 'ok') return { text: 'Pricing temporarily unavailable', tone: 'warning' };
  return null;
}

export function CartLines({ cart, compact = false }: { cart: Cart; compact?: boolean }) {
  const { setQuantity, remove } = useCartMutations();
  const { toast } = useToast();
  const degraded = isDegraded(cart);
  const fail = (e: unknown) => { const d = describeError(e); toast({ tone: 'danger', title: d.title, description: d.message }); };

  return (
    <ul className="divide-y divide-border">
      {cart.items.map((item) => {
        const note = lineNote(item, degraded);
        const name = item.name ?? 'Item (details unavailable right now)';
        return (
          <li key={item.productId} className={cn('flex gap-4 py-4', compact ? 'items-start' : 'items-start sm:items-center')}>
            <div className="min-w-0 flex-1">
              <Link to={`/products/${item.productId}`} className="block truncate font-medium text-ink hover:text-accent">{name}</Link>
              {item.sku && <p className="mt-0.5 text-xs text-muted tabular">{item.sku}</p>}
              {note && <Badge tone={note.tone} className="mt-1.5">{note.text}</Badge>}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <QuantityStepper size="sm" value={item.quantity} max={MAX_QTY} disabled={setQuantity.isPending}
                  onChange={(q) => setQuantity.mutate({ productId: item.productId, quantity: q }, { onError: fail })} />
                <button type="button" onClick={() => remove.mutate(item.productId, { onError: fail })}
                  className="text-sm font-medium text-muted underline-offset-2 hover:text-danger hover:underline">Remove</button>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
              {note?.tone === 'danger' ? null : (
                <>
                  <Price paise={item.lineTotalInPaise} currency={item.currency} unavailableText={degraded ? 'Unavailable' : 'Updating…'} />
                  {typeof item.unitPriceInPaise === 'number' && item.quantity > 1 && (
                    <span className="text-xs text-muted tabular"><Price paise={item.unitPriceInPaise} currency={item.currency} size="sm" muted className="font-normal" /> each</span>
                  )}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Subtotal row from the SERVER's total; a degraded cart shows the explanation instead of a number. */
export function CartTotal({ cart, size = 'lg' }: { cart: Cart; size?: 'md' | 'lg' | 'xl' }) {
  const degraded = isDegraded(cart);
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-sm text-muted">Subtotal ({cart.totalQuantity} item{cart.totalQuantity === 1 ? '' : 's'})</span>
      <Price paise={degraded ? null : cart.totalInPaise} currency={cart.currency ?? 'INR'} size={size}
        unavailableText={degraded ? 'Pricing unavailable' : 'Updating…'} />
    </div>
  );
}
