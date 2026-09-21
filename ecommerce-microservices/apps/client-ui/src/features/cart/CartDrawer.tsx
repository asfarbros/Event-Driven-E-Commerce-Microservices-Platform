import { useNavigate } from 'react-router';
import { useAuth } from '@clerk/clerk-react';
import { useCart } from '@/api/queries';
import { Drawer } from '@/components/ui/Overlay';
import { Button, ButtonLink } from '@/components/ui/Button';
import { LineSkeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { CartLines, CartTotal, isDegraded, hasUnavailable } from './CartLines';

/** Slide-in cart from the header for a quick look; the full page is /cart. */
export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isSignedIn } = useAuth();
  const cart = useCart(!!isSignedIn && open);
  const navigate = useNavigate();
  const go = (to: string) => { onClose(); navigate(to); };

  const blocked = isDegraded(cart.data) || hasUnavailable(cart.data);
  const footer = cart.data && cart.data.items.length > 0 ? (
    <div className="flex flex-col gap-3">
      <CartTotal cart={cart.data} />
      {isDegraded(cart.data) && <p className="text-sm text-warning">Prices are temporarily unavailable, so checkout is paused. Your items are safe.</p>}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={() => go('/cart')}>View cart</Button>
        <Button onClick={() => go('/checkout')} disabled={blocked}>Checkout</Button>
      </div>
    </div>
  ) : undefined;

  return (
    <Drawer open={open} onClose={onClose} title="Your cart" footer={footer}>
      {!isSignedIn ? (
        <EmptyState title="Sign in to see your cart" description="Your cart is saved to your account so it follows you between devices."
          action={<ButtonLink to="/sign-in?redirect_url=%2Fcart" onClick={onClose}>Sign in</ButtonLink>} />
      ) : cart.isPending ? (
        <LineSkeleton lines={4} />
      ) : cart.isError ? (
        <ErrorState error={cart.error} onRetry={() => cart.refetch()} compact />
      ) : cart.data.items.length === 0 ? (
        <EmptyState title="Your cart is empty" description="Find something you like in the shop."
          action={<Button variant="secondary" onClick={() => go('/')}>Continue shopping</Button>} />
      ) : (
        <CartLines cart={cart.data} compact />
      )}
    </Drawer>
  );
}
