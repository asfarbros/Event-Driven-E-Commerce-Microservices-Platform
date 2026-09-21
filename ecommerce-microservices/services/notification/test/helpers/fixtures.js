/** A command exactly as the Order Service's OutboxWriter.notification() emits it. */
export const ORDER_ID = '7f3d2a10-5b6c-4e8f-9a1b-2c3d4e5f6a7b';

export function confirmationCommand(overrides = {}) {
  return {
    messageId: `notify-${ORDER_ID}-order.confirmed`,
    commandType: 'SendOrderConfirmation',
    version: 1,
    source: 'order',
    occurredAt: '2026-09-21T10:15:30.123456Z',
    correlationId: 'req-abc-123',
    orderId: ORDER_ID,
    userId: 'user_3JYkPTWs9a02pFod2apjeDjAxK9',
    status: 'CONFIRMED',
    totalInPaise: 129900,
    currency: 'INR',
    items: [
      { productId: '66f1a2b3c4d5e6f7a8b9c0d1', sku: 'HDPH-001', name: 'Noise-cancelling headphones', quantity: 1, unitPriceInPaise: 99900, lineTotalInPaise: 99900 },
      { productId: '66f1a2b3c4d5e6f7a8b9c0d2', sku: 'CBL-USBC', name: 'USB-C cable 2 m', quantity: 2, unitPriceInPaise: 15000, lineTotalInPaise: 30000 },
    ],
    ...overrides,
  };
}

export function cancellationCommand(overrides = {}) {
  return confirmationCommand({
    messageId: `notify-${ORDER_ID}-order.cancelled`,
    commandType: 'SendOrderCancellation',
    status: 'CANCELLED',
    reason: 'cancelled by user after payment — refund requested',
    ...overrides,
  });
}

export function paymentFailedCommand(overrides = {}) {
  return cancellationCommand({ status: 'FAILED', reason: 'payment failed: card declined by issuer', ...overrides });
}

export const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
