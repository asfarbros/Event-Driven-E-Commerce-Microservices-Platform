package com.orderflow.order.domain;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/**
 * A message waiting to be published, written in the SAME transaction as the
 * state change that requires it. See outbox/OutboxRelay for the publishing
 * side and the guarantee.
 */
@Entity
@Table(name = "outbox_event")
public class OutboxEvent {

    public enum Destination { KAFKA, RABBITMQ }

    @Id
    @Column(nullable = false)
    private UUID id;

    @Column(name = "order_id", nullable = false, length = 64)
    private String orderId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    private Destination destination;

    @Column(nullable = false, length = 249)
    private String target;

    @Column(name = "routing_key", nullable = false, length = 249)
    private String routingKey;

    @Column(name = "event_type", nullable = false, length = 100)
    private String eventType;

    @Column(name = "message_id", nullable = false, length = 128)
    private String messageId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String payload;

    @Column(name = "correlation_id", length = 128)
    private String correlationId;

    @Column(nullable = false)
    private int attempts;

    @Column(name = "last_error", length = 500)
    private String lastError;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "published_at")
    private Instant publishedAt;

    protected OutboxEvent() {
    }

    public OutboxEvent(String orderId, Destination destination, String target, String routingKey, String eventType,
                       String messageId, String payload, String correlationId, Instant createdAt) {
        this.id = UUID.randomUUID();
        this.orderId = orderId;
        this.destination = destination;
        this.target = target;
        this.routingKey = routingKey;
        this.eventType = eventType;
        this.messageId = messageId;
        this.payload = payload;
        this.correlationId = correlationId;
        this.createdAt = createdAt;
    }

    public void markPublished(Instant when) {
        this.publishedAt = when;
        this.lastError = null;
    }

    public void recordFailure(String error) {
        this.attempts++;
        this.lastError = OrderStatusHistory.truncate(error, 500);
    }

    public UUID getId() { return id; }
    public String getOrderId() { return orderId; }
    public Destination getDestination() { return destination; }
    public String getTarget() { return target; }
    public String getRoutingKey() { return routingKey; }
    public String getEventType() { return eventType; }
    public String getMessageId() { return messageId; }
    public String getPayload() { return payload; }
    public String getCorrelationId() { return correlationId; }
    public int getAttempts() { return attempts; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getPublishedAt() { return publishedAt; }
}
