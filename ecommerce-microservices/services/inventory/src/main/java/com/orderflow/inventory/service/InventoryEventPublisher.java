package com.orderflow.inventory.service;

/**
 * Outbound port for {@code inventory-events}. Implemented over Kafka in
 * {@code kafka/KafkaInventoryEventPublisher}; a no-op or in-memory version is
 * enough for tests. Always called AFTER the owning transaction has committed.
 */
public interface InventoryEventPublisher {

    void publish(InventoryEvent event);
}
