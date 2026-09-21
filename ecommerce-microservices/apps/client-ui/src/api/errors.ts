/**
 * ONE error-handling layer. Every backend error has the same shape
 * `{ error, message, requestId, details? }`; this file turns it into a typed
 * ApiError and into calm, human copy. Pages never build error text themselves.
 */
export interface ShortItem { productId: string; requested: number; available: number; shortBy: number; reason?: string }
export interface PriceChange { productId: string; name?: string; sku?: string; oldUnitPriceInPaise?: number; newUnitPriceInPaise?: number; previousUnitPriceInPaise?: number; currentUnitPriceInPaise?: number }

export class ApiError extends Error {
  constructor(
    public readonly status: number,          // 0 = network failure
    public readonly code: string,            // backend `error` code, or a synthetic one (network_error, timeout)
    message: string,
    public readonly requestId: string | null,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/** Transient: worth a "Try again" button / an automatic retry. */
export function isRetryable(e: unknown): boolean {
  if (!isApiError(e)) return true;
  return e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504 || e.status === 429;
}

export interface ErrorCopy { title: string; message: string; }

/** Calm, plain-English copy. Never technical, never blaming the customer. */
export function describeError(e: unknown): ErrorCopy {
  if (!isApiError(e)) {
    return { title: 'Something went wrong', message: 'Please try again in a moment.' };
  }
  switch (e.code) {
    case 'network_error':
      return { title: 'We can’t reach the store right now', message: 'Check your connection and try again. Nothing has been charged.' };
    case 'timeout':
      return { title: 'That took too long', message: 'The store is a little slow at the moment. Please try again.' };
    case 'unauthorized':
      return { title: 'Please sign in again', message: 'Your session has expired. Sign in to continue where you left off.' };
    case 'not_found':
      return { title: 'We couldn’t find that', message: 'It may have been removed, or the link may be incorrect.' };
    case 'cart_empty':
      return { title: 'Your cart is empty', message: 'Add something to your cart before checking out.' };
    case 'cart_has_unavailable_items':
    case 'product_unavailable':
      return { title: 'Some items are no longer available', message: 'Remove them from your cart to continue.' };
    case 'insufficient_stock':
      return { title: 'Not enough stock', message: 'Some items in your cart aren’t available in that quantity. Nothing has been charged.' };
    case 'price_changed':
      return { title: 'A price has changed', message: 'Please review the new price before paying.' };
    case 'cancel_not_allowed':
      return { title: 'This order can’t be cancelled right now', message: 'It is still being placed. Try again in a moment.' };
    case 'idempotency_key_conflict':
      return { title: 'This checkout was already started', message: 'Start the checkout again from your cart.' };
    case 'payment_rejected':
      return { title: 'Payment could not be set up', message: 'The payment provider declined the request. Nothing has been charged — please try again.' };
    case 'quantity_limit_exceeded':
    case 'cart_full':
      return { title: 'That’s the limit for this item', message: e.message };
    case 'rate_limited':
      return { title: 'Too many requests', message: 'Please wait a moment and try again.' };
    default:
      break;
  }
  if (e.status === 503 || e.status === 502 || e.status === 504) {
    return { title: 'Temporarily unavailable', message: 'Part of the store is briefly unavailable. Nothing has been charged — please try again in a moment.' };
  }
  if (e.status === 401) return describeError(new ApiError(401, 'unauthorized', e.message, e.requestId));
  if (e.status === 404) return describeError(new ApiError(404, 'not_found', e.message, e.requestId));
  if (e.status >= 500) return { title: 'Something went wrong on our side', message: 'Please try again in a moment.' };
  if (e.status === 400 || e.status === 422) return { title: 'That didn’t work', message: 'Please check the details and try again.' };
  return { title: 'Something went wrong', message: 'Please try again in a moment.' };
}

/** The 409 insufficient_stock details, typed. */
export function shortItemsOf(e: unknown): ShortItem[] {
  if (!isApiError(e) || e.code !== 'insufficient_stock' || !Array.isArray(e.details)) return [];
  return e.details as ShortItem[];
}

/** The 409 price_changed details (proceed or reject policy both carry them), typed. */
export function priceChangesOf(e: unknown): PriceChange[] {
  if (!isApiError(e) || e.code !== 'price_changed') return [];
  const d = e.details as { priceChanges?: PriceChange[] } | PriceChange[] | undefined;
  if (Array.isArray(d)) return d;
  return d?.priceChanges ?? [];
}
