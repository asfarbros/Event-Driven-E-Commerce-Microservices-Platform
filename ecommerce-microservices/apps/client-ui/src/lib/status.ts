/**
 * Order status vocabulary — mirrors the Order Service's state machine
 * (services/order: PENDING → RESERVED → AWAITING_PAYMENT → CONFIRMED | FAILED | CANCELLED).
 * Semantic tones are separate from the accent: green confirmed, amber
 * in-progress, red failed, grey cancelled.
 */
export type OrderStatus = 'PENDING' | 'RESERVED' | 'AWAITING_PAYMENT' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
export type PaymentStatus = 'UNPAID' | 'PAID' | 'REFUND_PENDING' | 'REFUNDED';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['CONFIRMED', 'FAILED', 'CANCELLED']);
export const isTerminal = (status: string | undefined) => !!status && TERMINAL_STATUSES.has(status);

export const STATUS_META: Record<OrderStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; blurb: string }> = {
  PENDING: { label: 'Placing order', tone: 'warning', blurb: 'We have your order and are reserving your items.' },
  RESERVED: { label: 'Stock reserved', tone: 'warning', blurb: 'Your items are held for you while payment completes.' },
  AWAITING_PAYMENT: { label: 'Awaiting payment', tone: 'warning', blurb: 'Waiting for your payment to be confirmed.' },
  CONFIRMED: { label: 'Confirmed', tone: 'success', blurb: 'Payment received. Your order is confirmed.' },
  FAILED: { label: 'Not completed', tone: 'danger', blurb: 'This order could not be completed. Nothing was charged.' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', blurb: 'This order was cancelled.' },
};

export const PAYMENT_META: Record<PaymentStatus, string> = {
  UNPAID: 'Not paid',
  PAID: 'Paid',
  REFUND_PENDING: 'Refund in progress',
  REFUNDED: 'Refunded',
};
