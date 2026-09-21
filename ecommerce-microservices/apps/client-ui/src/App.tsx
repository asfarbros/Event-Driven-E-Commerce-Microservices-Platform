import { lazy, Suspense, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { ClerkProvider, useAuth } from '@clerk/clerk-react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { AppConfig } from './config/env';
import { makeQueryClient } from './api/queries';
import { clerkAppearance } from './styles/clerk';
import { ToastProvider } from './components/ui/Toast';
import { Shell, Container } from './components/layout/Shell';
import { AuthBridge } from './components/layout/AuthBridge';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { Skeleton } from './components/ui/Skeleton';
import { ProductListPage } from './pages/ProductListPage';

// Routes are code-split; only the listing (the landing page) ships in the main chunk.
const ProductDetailPage = lazy(() => import('./pages/ProductDetailPage').then((m) => ({ default: m.ProductDetailPage })));
const CartPage = lazy(() => import('./pages/CartPage').then((m) => ({ default: m.CartPage })));
const CheckoutPage = lazy(() => import('./pages/CheckoutPage').then((m) => ({ default: m.CheckoutPage })));
const OrderStatusPage = lazy(() => import('./pages/OrderStatusPage').then((m) => ({ default: m.OrderStatusPage })));
const OrdersPage = lazy(() => import('./pages/OrdersPage').then((m) => ({ default: m.OrdersPage })));
const OrderDetailPage = lazy(() => import('./pages/OrderDetailPage').then((m) => ({ default: m.OrderDetailPage })));
const SignInPage = lazy(() => import('./pages/AuthPages').then((m) => ({ default: m.SignInPage })));
const SignUpPage = lazy(() => import('./pages/AuthPages').then((m) => ({ default: m.SignUpPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));
// Dev-only pages: the `import.meta.env.DEV` branch is dead code in production, so Rollup drops them from the build.
const StyleGuidePage = import.meta.env.DEV ? lazy(() => import('./pages/dev/StyleGuidePage').then((m) => ({ default: m.StyleGuidePage }))) : null;
const DevTicketSignInPage = import.meta.env.DEV ? lazy(() => import('./pages/dev/DevTicketSignInPage').then((m) => ({ default: m.DevTicketSignInPage }))) : null;

function PageFallback() {
  return (
    <Container className="py-10">
      <Skeleton className="h-8 w-48" /><Skeleton className="mt-4 h-4 w-full max-w-prose" /><Skeleton className="mt-2 h-4 w-2/3 max-w-prose" />
    </Container>
  );
}

/** Cart, checkout and orders need a signed-in user; others are sent to sign-in and brought back afterwards. */
function Protected({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  if (!isLoaded) return <PageFallback />;
  if (!isSignedIn) return <Navigate to={`/sign-in?redirect_url=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

export function App({ config }: { config: AppConfig }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <ErrorBoundary>
      <ClerkProvider publishableKey={config.clerkPublishableKey} appearance={clerkAppearance()} signInUrl="/sign-in" signUpUrl="/sign-up"
        signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/">
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <BrowserRouter>
              <AuthBridge />
              <Suspense fallback={<PageFallback />}>
                <Routes>
                  <Route element={<Shell />}>
                    <Route index element={<ProductListPage />} />
                    <Route path="products/:id" element={<ProductDetailPage />} />
                    <Route path="cart" element={<Protected><CartPage /></Protected>} />
                    <Route path="checkout" element={<Protected><CheckoutPage /></Protected>} />
                    <Route path="orders" element={<Protected><OrdersPage /></Protected>} />
                    <Route path="orders/:id" element={<Protected><OrderDetailPage /></Protected>} />
                    <Route path="orders/:id/status" element={<Protected><OrderStatusPage /></Protected>} />
                    <Route path="sign-in/*" element={<SignInPage />} />
                    <Route path="sign-up/*" element={<SignUpPage />} />
                    {StyleGuidePage && <Route path="dev/styleguide" element={<StyleGuidePage />} />}
                    {DevTicketSignInPage && <Route path="dev/sign-in-with-ticket" element={<DevTicketSignInPage />} />}
                    <Route path="*" element={<NotFoundPage />} />
                  </Route>
                </Routes>
              </Suspense>
            </BrowserRouter>
          </ToastProvider>
        </QueryClientProvider>
      </ClerkProvider>
    </ErrorBoundary>
  );
}
