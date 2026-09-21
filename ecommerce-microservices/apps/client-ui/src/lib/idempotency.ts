/**
 * Idempotency keys for checkout. One stable UUID per CHECKOUT ATTEMPT — i.e.
 * per cart state. The same key is reused on a retry (network blip, 503, a
 * second click), so the Order Service returns the original order instead of
 * creating another; a changed cart gets a fresh key, because the backend
 * fingerprints only the request body and would otherwise replay the old order.
 * Kept in sessionStorage so a reload mid-checkout still retries the same
 * attempt. Disabling the button is a courtesy; the key is the real protection.
 */
import type { Cart } from '@/api/types';

const PREFIX = 'orderflow:checkout:';

export function cartSignature(cart: Cart): string {
  const items = [...cart.items].sort((a, b) => a.productId.localeCompare(b.productId)).map((i) => `${i.productId}x${i.quantity}`).join(',');
  return `${cart.userId}|${items}|${cart.updatedAt ?? ''}`;
}

export function idempotencyKeyFor(cart: Cart): string {
  const sig = cartSignature(cart);
  try {
    const stored = sessionStorage.getItem(PREFIX + 'sig');
    const key = sessionStorage.getItem(PREFIX + 'key');
    if (stored === sig && key) return key;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(PREFIX + 'sig', sig);
    sessionStorage.setItem(PREFIX + 'key', fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();   // storage blocked: still a valid key for this page's lifetime
  }
}

/** After an order is created (or the attempt is abandoned), the next checkout must start a new attempt. */
export function resetIdempotencyKey(): void {
  try { sessionStorage.removeItem(PREFIX + 'sig'); sessionStorage.removeItem(PREFIX + 'key'); } catch { /* ignore */ }
}
