import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { SignedIn, SignedOut, UserButton, useAuth } from '@clerk/clerk-react';
import { cn } from '@/lib/cn';
import { useCart } from '@/api/queries';
import { CartDrawer } from '@/features/cart/CartDrawer';
import { ErrorBoundary } from './ErrorBoundary';

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-content px-4 sm:px-6', className)}>{children}</div>;
}

const navLink = ({ isActive }: { isActive: boolean }) =>
  cn('rounded-md px-3 py-2 text-sm font-medium transition-colors duration-(--duration-fast) hover:bg-surface-2', isActive ? 'text-ink' : 'text-muted');

export function Shell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { isSignedIn } = useAuth();
  const cart = useCart(!!isSignedIn);
  const count = cart.data?.totalQuantity ?? 0;
  const location = useLocation();

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-semibold">Skip to content</a>
      <header className="sticky top-[env(safe-area-inset-top,0px)] z-30 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
        <Container className="flex h-16 items-center justify-between gap-4">
          <Link to="/" className="font-display text-2xl font-medium tracking-tight text-ink">OrderFlow</Link>
          <nav aria-label="Primary" className="hidden items-center gap-1 sm:flex">
            <NavLink to="/" end className={navLink}>Shop</NavLink>
            <SignedIn><NavLink to="/orders" className={navLink}>Orders</NavLink></SignedIn>
          </nav>
          <div className="flex items-center gap-2">
            <SignedOut>
              <Link to={`/sign-in?redirect_url=${encodeURIComponent(location.pathname + location.search)}`}
                className="rounded-md px-3 py-2 text-sm font-semibold text-accent hover:bg-accent-soft">Sign in</Link>
            </SignedOut>
            <button type="button" onClick={() => setDrawerOpen(true)} aria-label={`Open cart, ${count} item${count === 1 ? '' : 's'}`}
              className="relative grid size-10 place-items-center rounded-md text-ink transition-colors duration-(--duration-fast) hover:bg-surface-2">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 8H6.2" /><circle cx="9.5" cy="20" r="1.25" /><circle cx="17" cy="20" r="1.25" />
              </svg>
              {count > 0 && (
                <span className="absolute -right-0.5 -top-0.5 grid min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] font-bold leading-5 text-accent-ink tabular">{count > 99 ? '99+' : count}</span>
              )}
            </button>
            <SignedIn><UserButton /></SignedIn>
          </div>
        </Container>
        <nav aria-label="Primary (mobile)" className="flex gap-1 border-t border-border px-2 py-1 sm:hidden">
          <NavLink to="/" end className={navLink}>Shop</NavLink>
          <SignedIn><NavLink to="/orders" className={navLink}>Orders</NavLink></SignedIn>
        </nav>
      </header>

      <main id="main" className="flex-1 pb-[env(safe-area-inset-bottom,0px)]">
        <ErrorBoundary><Outlet /></ErrorBoundary>
      </main>

      <footer className="border-t border-border">
        <Container className="flex flex-col gap-2 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>OrderFlow · a demonstration storefront. Payments run in Razorpay test mode — no real money moves.</p>
          <p className="tabular">Prices in ₹ (INR), inclusive of taxes.</p>
        </Container>
      </footer>

      <CartDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
