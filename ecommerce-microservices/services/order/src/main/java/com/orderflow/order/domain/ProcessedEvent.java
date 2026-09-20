package com.orderflow.order.domain;

import java.time.Instant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** The Kafka INBOX row: inserted in the same transaction as the effect of the event. PK = event id. */
@Entity
@Table(name = "processed_event")
public class ProcessedEvent {

    @Id
    @Column(name = "event_id", nullable = false, length = 128)
    private String eventId;

    @Column(nullable = false, length = 249)
    private String topic;

    @Column(name = "event_type", nullable = false, length = 100)
    private String eventType;

    @Column(name = "order_id", length = 64)
    private String orderId;

    @Column(nullable = false, length = 30)
    private String outcome;

    @Column(name = "processed_at", nullable = false)
    private Instant processedAt;

    protected ProcessedEvent() {
    }

    public ProcessedEvent(String eventId, String topic, String eventType, String orderId, String outcome, Instant processedAt) {
        this.eventId = eventId;
        this.topic = topic;
        this.eventType = eventType;
        this.orderId = orderId;
        this.outcome = outcome;
        this.processedAt = processedAt;
    }

    public void setOutcome(String outcome) {
        this.outcome = outcome;
    }

    public String getEventId() { return eventId; }
    public String getTopic() { return topic; }
    public String getEventType() { return eventType; }
    public String getOrderId() { return orderId; }
    public String getOutcome() { return outcome; }
    public Instant getProcessedAt() { return processedAt; }
}
