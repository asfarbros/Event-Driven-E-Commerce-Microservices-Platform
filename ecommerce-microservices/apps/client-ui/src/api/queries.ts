/**
 * Server state = TanStack Query. Query keys, fetchers and mutation hooks live
 * here so pages contain no fetching logic. Retry policy: transient failures
 * (network / 502 / 503 / 504 / 429) retry with backoff; everything else fails
 * fast so the error layer can explain it.
 */
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { isRetryable } from './errors';
import type { Cart, CheckoutResult, CancelResult, Order, OrderList, OrderStatusView, Product, ProductList, ProductSort, Stock } from './types';

export const keys = {
  products: (params: ProductQuery) => ['products', params] as const,
  product: (id: string) => ['product', id] as const,
  categories: ['categories'] as const,
  cart: ['cart'] as const,
  stock: (productId: string) => ['stock', productId] as const,
  orders: (page: number) => ['orders', page] as const,
  order: (id: string) => ['order', id] as const,
  orderStatus: (id: string) => ['order-status', id] as const,
};

export const retryTransient = (failureCount: number, error: unknown) => isRetryable(error) && failureCount < 2;
export const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 4000);

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: retryTransient, retryDelay, staleTime: 30_000, refetchOnWindowFocus: false }, mutations: { retry: 0 } } });
}

// ---------------------------------------------------------------------------
// Catalog (public — no token)
// ---------------------------------------------------------------------------
export interface ProductQuery { page?: number; limit?: number; category?: string; q?: string; sort?: ProductSort }

export function useProducts(params: ProductQuery) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.category) qs.set('category', params.category);
  if (params.q) qs.set('q', params.q);
  if (params.sort) qs.set('sort', params.sort);
  return useQuery({
    queryKey: keys.products(params),
    queryFn: async ({ signal }) => (await api<ProductList>(`/api/catalog/products?${qs}`, { auth: false, signal })).data,
    placeholderData: (prev) => prev,      // keep the grid while paging / filtering
  });
}

export function useProduct(id: string) {
  return useQuery({
    queryKey: keys.product(id),
    queryFn: async ({ signal }) => (await api<Product>(`/api/catalog/products/${encodeURIComponent(id)}`, { auth: false, signal })).data,
    staleTime: 60_000,
  });
}

/**
 * Categories: the Gateway/Catalog contract has no categories endpoint (reported
 * as a gap), so they are derived from one page of the catalogue (limit is the
 * Catalog maximum, 100). Cached for 10 minutes.
 */
export function useCategories() {
  return useQuery({
    queryKey: keys.categories,
    queryFn: async ({ signal }) => {
      const list = (await api<ProductList>('/api/catalog/products?limit=100', { auth: false, signal })).data;
      return Array.from(new Set(list.items.map((p) => p.category))).sort();
    },
    staleTime: 10 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// Cart (protected). Writes return an UNPRICED view, so the cache is patched
// optimistically for quantity changes and then the priced cart is refetched.
// ---------------------------------------------------------------------------
export function useCart(enabled = true) {
  return useQuery({
    queryKey: keys.cart,
    queryFn: async ({ signal }) => (await api<Cart>('/api/cart/', { signal })).data,
    enabled,
    staleTime: 15_000,
  });
}

function patchQuantity(cart: Cart | undefined, productId: string, quantity: number): Cart | undefined {
  if (!cart) return cart;
  const items = quantity <= 0 ? cart.items.filter((i) => i.productId !== productId)
    : cart.items.map((i) => (i.productId === productId ? { ...i, quantity, lineTotalInPaise: null } : i));
  // Money is never computed in the browser: while the optimistic patch is in flight the line total and the
  // cart total are hidden (null → "Updating…"), and the server's numbers replace them on refetch.
  return { ...cart, items, itemCount: items.length, totalQuantity: items.reduce((n, i) => n + i.quantity, 0), totalInPaise: null };
}

export function useCartMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.cart });

  const add = useMutation({
    mutationFn: async ({ productId, quantity }: { productId: string; quantity: number }) =>
      (await api<Cart>('/api/cart/items', { method: 'POST', body: { productId, quantity } })).data,
    onSettled: invalidate,
  });

  const setQuantity = useMutation({
    mutationFn: async ({ productId, quantity }: { productId: string; quantity: number }) =>
      (await api<Cart>(`/api/cart/items/${encodeURIComponent(productId)}`, { method: 'PATCH', body: { quantity } })).data,
    onMutate: async ({ productId, quantity }) => {
      await qc.cancelQueries({ queryKey: keys.cart });
      const previous = qc.getQueryData<Cart>(keys.cart);
      qc.setQueryData<Cart>(keys.cart, (c) => patchQuantity(c, productId, quantity));
      return { previous };
    },
    onError: (_e, _v, ctx) => { if (ctx?.previous) qc.setQueryData(keys.cart, ctx.previous); },   // rollback
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (productId: string) => (await api<Cart>(`/api/cart/items/${encodeURIComponent(productId)}`, { method: 'DELETE' })).data,
    onMutate: async (productId) => {
      await qc.cancelQueries({ queryKey: keys.cart });
      const previous = qc.getQueryData<Cart>(keys.cart);
      qc.setQueryData<Cart>(keys.cart, (c) => patchQuantity(c, productId, 0));
      return { previous };
    },
    onError: (_e, _v, ctx) => { if (ctx?.previous) qc.setQueryData(keys.cart, ctx.previous); },
    onSettled: invalidate,
  });

  const clear = useMutation({
    mutationFn: async () => { await api<void>('/api/cart/', { method: 'DELETE' }); },
    onSettled: invalidate,
  });

  return { add, setQuantity, remove, clear };
}

// ---------------------------------------------------------------------------
// Inventory (protected — stock is shown to signed-in shoppers only)
// ---------------------------------------------------------------------------
export function useStock(productId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.stock(productId),
    queryFn: async ({ signal }) => (await api<Stock>(`/api/inventory/stock/${encodeURIComponent(productId)}`, { signal })).data,
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Orders (protected)
// ---------------------------------------------------------------------------
export function useOrders(page: number, limit = 10) {
  return useQuery({
    queryKey: keys.orders(page),
    queryFn: async ({ signal }) => (await api<OrderList>(`/api/orders/?page=${page}&limit=${limit}`, { signal })).data,
    placeholderData: (prev) => prev,
  });
}

export function useOrder(id: string, opts: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: keys.order(id),
    queryFn: async ({ signal }) => (await api<Order>(`/api/orders/${encodeURIComponent(id)}`, { signal })).data,
    retry: (n, e) => isRetryable(e) && n < 2,
    ...opts,
  });
}

export async function fetchOrderStatus(id: string, signal?: AbortSignal): Promise<OrderStatusView> {
  return (await api<OrderStatusView>(`/api/orders/${encodeURIComponent(id)}/status`, { signal })).data;
}

export function useCheckout() {
  const qc = useQueryClient();
  return useMutation({
    /** Idempotency-Key: stable per checkout attempt; the SAME key is sent on a retry (see features/checkout). */
    mutationFn: async ({ idempotencyKey, note }: { idempotencyKey: string; note?: string }) =>
      (await api<CheckoutResult>('/api/orders/', { method: 'POST', body: { note }, headers: { 'Idempotency-Key': idempotencyKey }, timeoutMs: 30_000 })).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.cart }); qc.invalidateQueries({ queryKey: ['orders'] }); },
  });
}

export function useCancelOrder(orderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reason?: string) => (await api<CancelResult>(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', body: { reason } })).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.order(orderId) }); qc.invalidateQueries({ queryKey: keys.orderStatus(orderId) }); qc.invalidateQueries({ queryKey: ['orders'] }); },
  });
}
