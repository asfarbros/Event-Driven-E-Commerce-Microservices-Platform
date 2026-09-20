package com.orderflow.payment.service;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.orderflow.payment.domain.PaymentRefund;
import com.orderflow.payment.domain.PaymentStatus;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Pins the payment-events contract Order Service (Step 6) codes against. */
class PaymentEventTest {

    private final ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    private final PaymentView view = new PaymentView(UUID.randomUUID(), "ord-1", "user_1", 129900L, "INR", PaymentStatus.SUCCESS,
            "order_x", "pay_y", null, null, null, Instant.parse("2026-09-20T10:15:30Z"), Instant.parse("2026-09-20T10:16:30Z"));

    @Test
    void succeededEventCarriesTheDocumentedFields() throws Exception {
        JsonNode json = mapper.readTree(mapper.writeValueAsString(PaymentEvent.succeeded(view, "req-1")));
        assertThat(json.get("eventType").asText()).isEqualTo("PaymentSucceeded");
        assertThat(json.get("version").asInt()).isEqualTo(1);
        assertThat(json.get("source").asText()).isEqualTo("payment");
        assertThat(json.get("correlationId").asText()).isEqualTo("req-1");
        assertThat(json.get("orderId").asText()).isEqualTo("ord-1");
        assertThat(json.get("paymentId").asText()).isEqualTo(view.paymentId().toString());
        assertThat(json.get("userId").asText()).isEqualTo("user_1");
        assertThat(json.get("amountInPaise").isIntegralNumber()).as("money is an integer, never a float").isTrue();
        assertThat(json.get("amountInPaise").asLong()).isEqualTo(129900L);
        assertThat(json.get("currency").asText()).isEqualTo("INR");
        assertThat(json.get("razorpayOrderId").asText()).isEqualTo("order_x");
        assertThat(json.get("razorpayPaymentId").asText()).isEqualTo("pay_y");
        assertThat(json.get("eventId").asText()).isNotBlank();
        assertThat(json.get("occurredAt").asText()).isNotBlank();
        assertThat(json.has("failureReason")).isFalse();
        assertThat(json.has("razorpayRefundId")).isFalse();
    }

    @Test
    void failedCarriesTheReasonAndRefundedTheRefundId() throws Exception {
        PaymentView failed = new PaymentView(view.paymentId(), "ord-1", "user_1", 129900L, "INR", PaymentStatus.FAILED,
                "order_x", "pay_y", "Card declined", null, null, view.createdAt(), view.updatedAt());
        JsonNode f = mapper.readTree(mapper.writeValueAsString(PaymentEvent.failed(failed, "req-2")));
        assertThat(f.get("eventType").asText()).isEqualTo("PaymentFailed");
        assertThat(f.get("failureReason").asText()).isEqualTo("Card declined");

        PaymentView refunded = new PaymentView(view.paymentId(), "ord-1", "user_1", 129900L, "INR", PaymentStatus.REFUNDED,
                "order_x", "pay_y", null, null,
                new PaymentView.RefundView(UUID.randomUUID(), PaymentRefund.Status.PROCESSED, "rfnd_z", 129900L, "order_cancelled", Instant.now()),
                view.createdAt(), view.updatedAt());
        JsonNode r = mapper.readTree(mapper.writeValueAsString(PaymentEvent.refunded(refunded, "req-3")));
        assertThat(r.get("eventType").asText()).isEqualTo("PaymentRefunded");
        assertThat(r.get("razorpayRefundId").asText()).isEqualTo("rfnd_z");
    }
}
