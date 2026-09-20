package com.orderflow.order.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

/**
 * The aggregate root. Status changes go through {@link #transitionTo}, which
 * enforces {@link OrderStatus#ALLOWED} and appends a history row — the audit
 * trail is written by the same code that makes the change, so it cannot be
 * forgotten.
 */
@Entity
@Table(name = "orders")
public class Order {

    /** Money, tracked independently of the fulfilment status. */
    public enum PaymentState { UNPAID, PAID, REFUND_PENDING, REFUNDED }

    /** What caused a transition — recorded in order_status_history.trigger. */
    public enum Trigger { CHECKOUT, PAYMENT_EVENT, INVENTORY_EVENT, USER, RECONCILIATION }

    @Id
    @Column(nullable = false)
    private UUID id;

    @Column(name = "user_id", nullable = false, length = 128)
    private String userId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private OrderStatus status;

    @Enumerated(EnumType.STRING)
    @Column(name = "payment_status", nullable = false, length = 20)
    private PaymentState paymentStatus;

    @Column(name = "total_in_paise", nullable = false)
    private long totalInPaise;

    @Column(nullable = false, length = 3)
    private String currency;

    @Column(name = "item_count", nullable = false)
    private int itemCount;

    @Column(name = "total_quantity", nullable = false)
    private int totalQuantity;

    @Column(name = "reservation_id", length = 64)
    private String reservationId;

    @Column(name = "reservation_expires_at")
    private Instant reservationExpiresAt;

    @Column(name = "payment_id", length = 64)
    private String paymentId;

    @Column(name = "razorpay_order_id", length = 64)
    private String razorpayOrderId;

    @Column(name = "razorpay_key_id", length = 64)
    private String razorpayKeyId;

    @Column(name = "idempotency_key", length = 128)
    private String idempotencyKey;

    @Column(name = "idempotency_fingerprint", length = 64)
    private String idempotencyFingerprint;

    @Column(name = "failure_reason", length = 500)
    private String failureReason;

    @Column(name = "created_by_request_id", length = 128)
    private String createdByRequestId;

    @Version
    @Column(nullable = false)
    private Long version;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    @OrderBy("id ASC")
    private List<OrderItem> items = new ArrayList<>();

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, fetch = FetchType.LAZY)
    @OrderBy("id ASC")
    private List<OrderStatusHistory> history = new ArrayList<>();

    protected Order() {
    }

    public Order(String userId, String currency, String idempotencyKey, String idempotencyFingerprint, String createdByRequestId) {
        this.id = UUID.randomUUID();
        this.userId = userId;
        this.currency = currency;
        this.status = OrderStatus.PENDING;
        this.paymentStatus = PaymentState.UNPAID;
        this.idempotencyKey = idempotencyKey;
        this.idempotencyFingerprint = idempotencyFingerprint;
        this.createdByRequestId = createdByRequestId;
    }

    /** Adds an immutable line and keeps the totals consistent. Called only at checkout. */
    public OrderItem addItem(String productId, String sku, String name, int quantity, long unitPriceInPaise) {
        OrderItem item = new OrderItem(this, productId, sku, name, quantity, unitPriceInPaise);
        items.add(item);
        itemCount = items.size();
        totalQuantity += quantity;
        totalInPaise += item.getLineTotalInPaise();
        return item;
    }

    /**
     * The ONLY way the status changes. Returns true if a transition happened,
     * false if the order was already in {@code target} (idempotent no-op).
     * Throws {@link OrderStatus.IllegalTransitionException} for anything the
     * state machine forbids — including any attempt to leave a terminal state.
     */
    public boolean transitionTo(OrderStatus target, Trigger trigger, String reason, String eventId, String requestId) {
        if (status == target) {
            return false;
        }
        if (!status.canTransitionTo(target)) {
            throw new OrderStatus.IllegalTransitionException(status, target);
        }
        history.add(new OrderStatusHistory(this, status, target, trigger, reason, eventId, requestId));
        status = target;
        if (target == OrderStatus.FAILED || target == OrderStatus.CANCELLED) {
            failureReason = OrderStatusHistory.truncate(reason, 500);
        }
        return true;
    }

    /** The first history row: created as PENDING (from = null). Called once, at checkout. */
    public void recordPlaced(String requestId) {
        history.add(new OrderStatusHistory(this, null, status, Trigger.CHECKOUT, "order placed from cart snapshot", null, requestId));
    }

    /** History row without a status change (e.g. "payment landed after cancellation, refund requested"). */
    public void note(Trigger trigger, String reason, String eventId, String requestId) {
        history.add(new OrderStatusHistory(this, status, status, trigger, reason, eventId, requestId));
    }

    public void attachReservation(String reservationId, Instant expiresAt) {
        this.reservationId = reservationId;
        this.reservationExpiresAt = expiresAt;
    }

    public void attachPayment(String paymentId, String razorpayOrderId, String razorpayKeyId) {
        this.paymentId = paymentId;
        this.razorpayOrderId = razorpayOrderId;
        this.razorpayKeyId = razorpayKeyId;
    }

    public void setPaymentStatus(PaymentState paymentStatus) {
        this.paymentStatus = paymentStatus;
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
    public String getUserId() { return userId; }
    public OrderStatus getStatus() { return status; }
    public PaymentState getPaymentStatus() { return paymentStatus; }
    public long getTotalInPaise() { return totalInPaise; }
    public String getCurrency() { return currency; }
    public int getItemCount() { return itemCount; }
    public int getTotalQuantity() { return totalQuantity; }
    public String getReservationId() { return reservationId; }
    public Instant getReservationExpiresAt() { return reservationExpiresAt; }
    public String getPaymentId() { return paymentId; }
    public String getRazorpayOrderId() { return razorpayOrderId; }
    public String getRazorpayKeyId() { return razorpayKeyId; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public String getIdempotencyFingerprint() { return idempotencyFingerprint; }
    public String getFailureReason() { return failureReason; }
    public String getCreatedByRequestId() { return createdByRequestId; }
    public Long getVersion() { return version; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public List<OrderItem> getItems() { return items; }
    public List<OrderStatusHistory> getHistory() { return history; }
}
