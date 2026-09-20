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
 * One (full) refund per payment. The row is written and COMMITTED before
 * Razorpay is asked for the money back; UNIQUE(payment_id) is the database's
 * guarantee that no second refund can ever be started for the same payment.
 */
@Entity
@Table(name = "payment_refund")
public class PaymentRefund {

    public enum Status { INITIATED, PROCESSED, FAILED }

    @Id
    @Column(nullable = false)
    private UUID id;

    @Column(name = "payment_id", nullable = false)
    private UUID paymentId;

    @Column(name = "amount_in_paise", nullable = false)
    private long amountInPaise;

    @Column(nullable = false, length = 3)
    private String currency;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private Status status;

    @Column(nullable = false, length = 100)
    private String reason;

    @Column(name = "razorpay_refund_id", length = 64)
    private String razorpayRefundId;

    @Column(name = "last_gateway_error", length = 500)
    private String lastGatewayError;

    @Column(name = "gateway_attempts", nullable = false)
    private int gatewayAttempts;

    @Column(name = "triggered_by_event_id", length = 128)
    private String triggeredByEventId;

    @Column(name = "created_by_request_id", length = 128)
    private String createdByRequestId;

    @Version
    @Column(nullable = false)
    private Long version;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected PaymentRefund() {
    }

    public PaymentRefund(PaymentTransaction payment, String reason, String triggeredByEventId, String createdByRequestId) {
        this.id = UUID.randomUUID();
        this.paymentId = payment.getId();
        this.amountInPaise = payment.getAmountInPaise();
        this.currency = payment.getCurrency();
        this.status = Status.INITIATED;
        this.reason = reason;
        this.triggeredByEventId = triggeredByEventId;
        this.createdByRequestId = createdByRequestId;
    }

    /** Razorpay accepted the refund request. {@code processed} = money already on its way back. */
    public void attachGatewayRefund(String razorpayRefundId, boolean processed) {
        this.razorpayRefundId = razorpayRefundId;
        this.lastGatewayError = null;
        if (processed) {
            this.status = Status.PROCESSED;
        }
    }

    public void markProcessed() {
        this.status = Status.PROCESSED;
    }

    public void markFailed(String error) {
        this.status = Status.FAILED;
        this.lastGatewayError = PaymentTransaction.truncate(error, 500);
    }

    public void recordGatewayFailure(String error) {
        this.gatewayAttempts++;
        this.lastGatewayError = PaymentTransaction.truncate(error, 500);
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
    public UUID getPaymentId() { return paymentId; }
    public long getAmountInPaise() { return amountInPaise; }
    public String getCurrency() { return currency; }
    public Status getStatus() { return status; }
    public String getReason() { return reason; }
    public String getRazorpayRefundId() { return razorpayRefundId; }
    public String getLastGatewayError() { return lastGatewayError; }
    public int getGatewayAttempts() { return gatewayAttempts; }
    public String getTriggeredByEventId() { return triggeredByEventId; }
    public Long getVersion() { return version; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
