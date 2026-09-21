/** Wire types — exactly what the Gateway returns (see the service READMEs). Money is ALWAYS integer paise. */
import type { OrderStatus, PaymentStatus } from '@/lib/status';

export interface Pagination { page: number; limit: number; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean }

export interface Product {
  id: string; name: string; description?: string; priceInPaise: number; currency: string; category: string;
  imageUrl?: string | null; sku: string; isActive: boolean; createdAt: string; updatedAt: string;
}
export type ProductSort = 'newest' | 'price_asc' | 'price_desc' | 'name_asc' | 'relevance';
export interface ProductList { items: Product[]; pagination: Pagination; sort: ProductSort; filters: { category?: string } }

export type PriceStatus = 'ok' | 'not_found' | 'inactive' | 'unavailable' | string;
export interface CartItem {
  productId: string; quantity: number; priceStatus: PriceStatus;
  name?: string; sku?: string; unitPriceInPaise?: number | null; lineTotalInPaise?: number | null; currency?: string;
}
export interface Cart {
  userId: string; items: CartItem[]; itemCount: number; totalQuantity: number; currency: string | null;
  totalInPaise: number | null;
  pricing?: { status: 'complete' | 'partial' | 'unavailable'; pricedItems: number; unpricedItems: number; pricedAt: string | null; reason: string | null };
  degraded?: boolean; updatedAt?: string;
}

export interface Stock { productId: string; available: number; reserved: number; updatedAt: string }

export interface OrderLine { productId: string; sku: string; name: string; quantity: number; unitPriceInPaise: number; lineTotalInPaise: number; currency: string }
export interface HistoryEntry { from: OrderStatus | null; to: OrderStatus; trigger: 'CHECKOUT' | 'PAYMENT_EVENT' | 'INVENTORY_EVENT' | 'USER' | 'RECONCILIATION'; reason: string | null; eventId: string | null; requestId: string | null; at: string }
export interface Order {
  orderId: string; status: OrderStatus; paymentStatus: PaymentStatus; totalInPaise: number; currency: string;
  itemCount: number; totalQuantity: number; items: OrderLine[];
  reservation: { reservationId: string; expiresAt: string } | null;
  payment: { paymentId: string; razorpayOrderId: string; razorpayKeyId: string; amountInPaise: number; currency: string } | null;
  failureReason: string | null; history: HistoryEntry[]; createdAt: string; updatedAt: string;
}
export interface OrderStatusView { orderId: string; status: OrderStatus; paymentStatus: PaymentStatus; updatedAt: string }
export interface OrderList { items: Order[]; pagination: Pagination }

/** POST /api/orders/ — what the browser needs to open Razorpay. Amount comes from the server, never the client. */
export interface CheckoutResult {
  orderId: string; status: OrderStatus; created: boolean; totalInPaise: number; currency: string; items: OrderLine[];
  reservation: { reservationId: string; expiresAt: string };
  payment: { paymentId: string; razorpayOrderId: string; razorpayKeyId: string; amountInPaise: number; currency: string };
  priceChanges?: Array<{ productId: string; name?: string; previousUnitPriceInPaise?: number; currentUnitPriceInPaise?: number; oldUnitPriceInPaise?: number; newUnitPriceInPaise?: number }>;
  requestId?: string;
}
export interface CancelResult { orderId: string; status: OrderStatus; cancelled: boolean; paymentStatus: PaymentStatus; requestId?: string }
