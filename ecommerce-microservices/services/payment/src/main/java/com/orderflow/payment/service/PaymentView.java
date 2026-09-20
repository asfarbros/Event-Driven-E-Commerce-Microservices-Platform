package com.orderflow.payment.service;

import java.time.Instant;
import java.util.UUID;

import com.orderflow.payment.domain.PaymentRefund;
import com.orderflow.payment.domain.PaymentStatus;
import com.orderflow.payment.domain.PaymentTransaction;

/** Immutable snapshot of a transaction (+ its refund, if any), built inside the transaction. */
public record PaymentView(
        UUID paymentId,
        String orderId,
        String userId,
        long amountInPaise,
        String currency,
        PaymentStatus status,
        String razorpayOrderId,
        String razorpayPaymentId,
        String failureReason,
        String lastGatewayError,
        RefundView refund,
        Instant createdAt,
        Instant updatedAt) {

    public record RefundView(UUID refundId, PaymentRefund.Status status, String razorpayRefundId, long amountInPaise,
                             String reason, Instant createdAt) {
        public static RefundView of(PaymentRefund r) {
            return new RefundView(r.getId(), r.getStatus(), r.getRazorpayRefundId(), r.getAmountInPaise(), r.getReason(), r.getCreatedAt());
        }
    }

    public static PaymentView of(PaymentTransaction p, PaymentRefund refund) {
        return new PaymentView(p.getId(), p.getOrderId(), p.getUserId(), p.getAmountInPaise(), p.getCurrency(), p.getStatus(),
                p.getRazorpayOrderId(), p.getRazorpayPaymentId(), p.getFailureReason(), p.getLastGatewayError(),
                refund != null ? RefundView.of(refund) : null, p.getCreatedAt(), p.getUpdatedAt());
    }
}
