package com.orderflow.order.domain;

import java.time.Instant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

/** One row per transition (or note) — the audit trail of an order. */
@Entity
@Table(name = "order_status_history")
public class OrderStatusHistory {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;

    @Enumerated(EnumType.STRING)
    @Column(name = "from_status", length = 20)
    private OrderStatus fromStatus;

    @Enumerated(EnumType.STRING)
    @Column(name = "to_status", nullable = false, length = 20)
    private OrderStatus toStatus;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 30)
    private Order.Trigger trigger;

    @Column(length = 500)
    private String reason;

    @Column(name = "event_id", length = 128)
    private String eventId;

    @Column(name = "request_id", length = 128)
    private String requestId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected OrderStatusHistory() {
    }

    OrderStatusHistory(Order order, OrderStatus from, OrderStatus to, Order.Trigger trigger, String reason, String eventId, String requestId) {
        this.order = order;
        this.fromStatus = from;
        this.toStatus = to;
        this.trigger = trigger;
        this.reason = truncate(reason, 500);
        this.eventId = eventId;
        this.requestId = requestId;
    }

    static String truncate(String s, int max) {
        if (s == null) return null;
        return s.length() <= max ? s : s.substring(0, max);
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
    }

    public Long getId() { return id; }
    public OrderStatus getFromStatus() { return fromStatus; }
    public OrderStatus getToStatus() { return toStatus; }
    public Order.Trigger getTrigger() { return trigger; }
    public String getReason() { return reason; }
    public String getEventId() { return eventId; }
    public String getRequestId() { return requestId; }
    public Instant getCreatedAt() { return createdAt; }
}
