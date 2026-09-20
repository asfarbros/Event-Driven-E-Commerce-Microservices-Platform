package com.orderflow.payment.service;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * EVENT CONTRACT for the {@code payment-events} topic. Order Service (Step 6)
 * consumes these. Same envelope style as inventory-events; fields never
 * change meaning, additions bump {@code version}.
 *
 * <pre>
 * {
 *   "eventId":           "uuid",                       // unique per event (consumer dedupe key)
 *   "eventType":         "PaymentSucceeded",           // PaymentSucceeded | PaymentFailed | PaymentRefunded
 *   "version":           1,
 *   "source":            "payment",
 *   "occurredAt":        "2026-09-20T10:15:30.123Z",   // ISO-8601 UTC
 *   "correlationId":     "…",                          // X-Request-Id of the originating request / webhook / job (also a header)
 *   "orderId":           "ord_123",                    // Kafka record KEY
 *   "paymentId":         "uuid",                       // OUR payment id
 *   "userId":            "user_…",
 *   "amountInPaise":     129900,                       // INTEGER paise — never a float
 *   "currency":          "INR",
 *   "razorpayOrderId":   "order_…",                    // external gateway ids (may be absent on early failures)
 *   "razorpayPaymentId": "pay_…",
 *   "razorpayRefundId":  "rfnd_…",                     // PaymentRefunded only
 *   "failureReason":     "…"                           // PaymentFailed only
 * }
 * </pre>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PaymentEvent(
        String eventId,
        String eventType,
        int version,
        String source,
        Instant occurredAt,
        String correlationId,
        String orderId,
        UUID paymentId,
        String userId,
        long amountInPaise,
        String currency,
        String razorpayOrderId,
        String razorpayPaymentId,
        String razorpayRefundId,
        String failureReason) {

    public static final int SCHEMA_VERSION = 1;
    public static final String SOURCE = "payment";

    public static final class EventType {
        public static final String SUCCEEDED = "PaymentSucceeded";
        public static final String FAILED = "PaymentFailed";
        public static final String REFUNDED = "PaymentRefunded";

        private EventType() {
        }
    }

    public static PaymentEvent succeeded(PaymentView p, String correlationId) {
        return of(EventType.SUCCEEDED, p, correlationId, null, null);
    }

    public static PaymentEvent failed(PaymentView p, String correlationId) {
        return of(EventType.FAILED, p, correlationId, null, p.failureReason());
    }

    public static PaymentEvent refunded(PaymentView p, String correlationId) {
        return of(EventType.REFUNDED, p, correlationId, p.refund() != null ? p.refund().razorpayRefundId() : null, null);
    }

    private static PaymentEvent of(String type, PaymentView p, String correlationId, String refundId, String failureReason) {
        return new PaymentEvent(UUID.randomUUID().toString(), type, SCHEMA_VERSION, SOURCE, Instant.now(), correlationId,
                p.orderId(), p.paymentId(), p.userId(), p.amountInPaise(), p.currency(), p.razorpayOrderId(),
                p.razorpayPaymentId(), refundId, failureReason);
    }
}
