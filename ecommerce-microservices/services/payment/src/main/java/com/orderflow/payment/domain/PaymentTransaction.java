package com.orderflow.payment.domain;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

/**
 * One payment attempt record per order (UNIQUE order_id). {@code id} is OUR
 * paymentId; the {@code razorpay*} fields are the external gateway's ids.
 *
 * <p>Money: {@code amountInPaise} is an integer in the smallest unit. It is the
 * exact value sent to Razorpay (which also works in the smallest unit) and the
 * exact value every webhook is checked against.
 */
@Entity
@Table(name = "payment_transaction")
public class PaymentTransaction {

    @Id
    @Column(nullable = false)
    private UUID id;

    @Column(name = "order_id", nullable = false, length = 64)
    private String orderId;

    @Column(name = "user_id", nullable = false, length = 128)
    private String userId;

    @Column(name = "amount_in_paise", nullable = false)
    private long amountInPaise;

    @Column(nullable = false, length = 3)
    private String currency;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private PaymentStatus status;

    @Column(name = "razorpay_order_id", length = 64)
    private String razorpayOrderId;

    @Column(name = "razorpay_payment_id", length = 64)
    private String razorpayPaymentId;

    @Column(name = "failure_reason", length = 500)
    private String failureReason;

    @Column(name = "last_gateway_error", length = 500)
    private String lastGatewayError;

    @Column(name = "gateway_attempts", nullable = false)
    private int gatewayAttempts;

    @Column(name = "created_by_request_id", length = 128)
    private String createdByRequestId;

    // Wrapper so Spring Data treats a null version as "new" (persist, not merge).
    @Version
    @Column(nullable = false)
    private Long version;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected PaymentTransaction() {
    }

    public PaymentTransaction(String orderId, String userId, long amountInPaise, String currency, String createdByRequestId) {
        this.id = UUID.randomUUID();
        this.orderId = orderId;
        this.userId = userId;
        this.amountInPaise = amountInPaise;
        this.currency = currency;
        this.status = PaymentStatus.CREATED;
        this.createdByRequestId = createdByRequestId;
    }

    /** CREATED → PENDING: the Razorpay order exists; the user can now pay. */
    public void attachGatewayOrder(String razorpayOrderId) {
        this.razorpayOrderId = razorpayOrderId;
        this.lastGatewayError = null;
        if (status == PaymentStatus.CREATED) {
            this.status = PaymentStatus.PENDING;
        }
    }

    public void recordGatewayFailure(String error) {
        this.gatewayAttempts++;
        this.lastGatewayError = truncate(error, 500);
    }

    /** → SUCCESS. Allowed from PENDING, and from FAILED (a retried attempt inside the same Razorpay checkout). */
    public void markSuccess(String razorpayPaymentId) {
        this.razorpayPaymentId = razorpayPaymentId;
        this.failureReason = null;
        this.status = PaymentStatus.SUCCESS;
    }

    public void markFailed(String razorpayPaymentId, String reason) {
        if (razorpayPaymentId != null) {
            this.razorpayPaymentId = razorpayPaymentId;
        }
        this.failureReason = truncate(reason, 500);
        this.status = PaymentStatus.FAILED;
    }

    public void markRefundPending() {
        this.status = PaymentStatus.REFUND_PENDING;
    }

    public void markRefunded() {
        this.status = PaymentStatus.REFUNDED;
    }

    /** Refund refused by Razorpay: back to SUCCESS (the money is still with us) with the reason recorded. */
    public void markRefundFailed(String reason) {
        this.failureReason = truncate("refund failed: " + reason, 500);
        this.status = PaymentStatus.SUCCESS;
    }

    public boolean isSettled() {
        return status == PaymentStatus.SUCCESS || status == PaymentStatus.REFUND_PENDING || status == PaymentStatus.REFUNDED;
    }

    static String truncate(String s, int max) {
        if (s == null) return null;
        return s.length() <= max ? s : s.substring(0, max);
    }

    @PrePersist
    void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public String getOrderId() { return orderId; }
    public String getUserId() { return userId; }
    public long getAmountInPaise() { return amountInPaise; }
    public String getCurrency() { return currency; }
    public PaymentStatus getStatus() { return status; }
    public String getRazorpayOrderId() { return razorpayOrderId; }
    public String getRazorpayPaymentId() { return razorpayPaymentId; }
    public String getFailureReason() { return failureReason; }
    public String getLastGatewayError() { return lastGatewayError; }
    public int getGatewayAttempts() { return gatewayAttempts; }
    public String getCreatedByRequestId() { return createdByRequestId; }
    public Long getVersion() { return version; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
