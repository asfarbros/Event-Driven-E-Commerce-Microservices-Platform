package com.orderflow.payment.web;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.orderflow.payment.domain.PaymentRefund;
import com.orderflow.payment.domain.PaymentStatus;
import com.orderflow.payment.service.PaymentView;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Request / response bodies. Money is {@code long amountInPaise} everywhere —
 * an integer in the smallest unit; there is no floating-point type in this
 * file, on purpose.
 */
public final class ApiDtos {

    private ApiDtos() {
    }

    public static final String ID_PATTERN = "^[A-Za-z0-9._-]{1,64}$";
    static final String ID_MESSAGE = "must be 1-64 characters of letters, digits, '.', '_' or '-'";

    // ---- POST /payments (server-to-server from Order Service) --------------

    public record CreatePaymentRequest(
            @NotBlank(message = "is required") @Pattern(regexp = ID_PATTERN, message = ID_MESSAGE) String orderId,
            @NotBlank(message = "is required") @Size(max = 128, message = "is too long")
            @Pattern(regexp = "^[A-Za-z0-9._-]{1,128}$", message = "must be 1-128 characters of letters, digits, '.', '_' or '-'") String userId,
            @NotNull(message = "is required") @Min(value = 1, message = "must be at least 1 paisa")
            @Max(value = 1_000_000_000_000L, message = "is too large") Long amountInPaise,
            @NotBlank(message = "is required") @Pattern(regexp = "^[A-Z]{3}$", message = "must be an ISO-4217 code such as INR") String currency) {
    }

    /**
     * What the browser needs to open the Razorpay checkout widget. It contains
     * the PUBLIC key id and the amount for display; the amount Razorpay
     * charges is the one bound to {@code razorpayOrderId} on Razorpay's side,
     * which we set from our database — the browser cannot change it.
     */
    public record CreatePaymentResponse(UUID paymentId, String orderId, PaymentStatus status, boolean created,
                                        String razorpayOrderId, String razorpayKeyId, long amountInPaise, String currency,
                                        Instant createdAt) {
        static CreatePaymentResponse of(PaymentView p, boolean created, String keyId) {
            return new CreatePaymentResponse(p.paymentId(), p.orderId(), p.status(), created, p.razorpayOrderId(), keyId,
                    p.amountInPaise(), p.currency(), p.createdAt());
        }
    }

    // ---- GET /payments/{orderId} -------------------------------------------

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RefundResponse(UUID refundId, PaymentRefund.Status status, String razorpayRefundId, long amountInPaise,
                                 String reason, Instant createdAt) {
        static RefundResponse of(PaymentView.RefundView r) {
            return r == null ? null : new RefundResponse(r.refundId(), r.status(), r.razorpayRefundId(), r.amountInPaise(), r.reason(), r.createdAt());
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PaymentResponse(UUID paymentId, String orderId, String userId, long amountInPaise, String currency,
                                  PaymentStatus status, String razorpayOrderId, String razorpayPaymentId, String failureReason,
                                  RefundResponse refund, Instant createdAt, Instant updatedAt) {
        static PaymentResponse of(PaymentView p) {
            return new PaymentResponse(p.paymentId(), p.orderId(), p.userId(), p.amountInPaise(), p.currency(), p.status(),
                    p.razorpayOrderId(), p.razorpayPaymentId(), p.failureReason(), RefundResponse.of(p.refund()),
                    p.createdAt(), p.updatedAt());
        }
    }

    // ---- POST /payments/{orderId}/refund -----------------------------------

    public record RefundRequest(@Size(max = 100, message = "is too long")
                                @Pattern(regexp = "^[A-Za-z0-9 ._-]*$", message = "may contain letters, digits, spaces, '.', '_' or '-'") String reason) {
    }

    public record RefundResult(String outcome, PaymentResponse payment) {
    }

    // ---- POST /webhooks/razorpay -------------------------------------------

    public record WebhookAck(String status, String eventType, String note, String requestId) {
    }

    // ---- Errors / health ---------------------------------------------------

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ApiError(String error, String message, String requestId, List<? extends Object> details) {
    }

    public record FieldError(String field, String message) {
    }

    public record HealthResponse(String status, String service, String version, long uptimeSeconds, Instant timestamp,
                                 Map<String, Object> db, Map<String, Object> kafka, Map<String, Object> razorpay,
                                 Map<String, Object> reconciliation, String requestId) {
    }
}
