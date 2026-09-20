package com.orderflow.payment.domain;

import java.time.Instant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/**
 * The webhook INBOX. One row per webhook Razorpay delivered; UNIQUE(provider,
 * provider_event_id) is what makes processing idempotent. {@code payload} is
 * the body AFTER {@code razorpay/PayloadRedactor} removed sensitive fields.
 */
@Entity
@Table(name = "webhook_event")
public class WebhookEvent {

    public enum Status { PROCESSED, IGNORED, FAILED }

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 20)
    private String provider;

    @Column(name = "provider_event_id", nullable = false, length = 128)
    private String providerEventId;

    @Column(name = "event_type", nullable = false, length = 100)
    private String eventType;

    @Column(name = "razorpay_order_id", length = 64)
    private String razorpayOrderId;

    @Column(name = "razorpay_payment_id", length = 64)
    private String razorpayPaymentId;

    @Column(name = "razorpay_refund_id", length = 64)
    private String razorpayRefundId;

    @Column(name = "order_id", length = 64)
    private String orderId;

    @Enumerated(EnumType.STRING)
    @Column(name = "processing_status", nullable = false, length = 20)
    private Status processingStatus;

    @Column(name = "processing_note", length = 500)
    private String processingNote;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String payload;

    @Column(name = "request_id", length = 128)
    private String requestId;

    @Column(name = "received_at", nullable = false, updatable = false)
    private Instant receivedAt;

    @Column(name = "processed_at")
    private Instant processedAt;

    protected WebhookEvent() {
    }

    public WebhookEvent(String provider, String providerEventId, String eventType, String razorpayOrderId,
                        String razorpayPaymentId, String razorpayRefundId, String orderId, String redactedPayload,
                        String requestId, Instant receivedAt) {
        this.provider = provider;
        this.providerEventId = providerEventId;
        this.eventType = eventType;
        this.razorpayOrderId = razorpayOrderId;
        this.razorpayPaymentId = razorpayPaymentId;
        this.razorpayRefundId = razorpayRefundId;
        this.orderId = orderId;
        this.payload = redactedPayload;
        this.requestId = requestId;
        this.receivedAt = receivedAt;
        this.processingStatus = Status.IGNORED;
    }

    public void resolve(Status status, String note, Instant when) {
        this.processingStatus = status;
        this.processingNote = PaymentTransaction.truncate(note, 500);
        this.processedAt = when;
    }

    public Long getId() { return id; }
    public String getProvider() { return provider; }
    public String getProviderEventId() { return providerEventId; }
    public String getEventType() { return eventType; }
    public String getRazorpayOrderId() { return razorpayOrderId; }
    public String getRazorpayPaymentId() { return razorpayPaymentId; }
    public String getRazorpayRefundId() { return razorpayRefundId; }
    public String getOrderId() { return orderId; }
    public Status getProcessingStatus() { return processingStatus; }
    public String getProcessingNote() { return processingNote; }
    public String getRequestId() { return requestId; }
    public Instant getReceivedAt() { return receivedAt; }
    public Instant getProcessedAt() { return processedAt; }
}
