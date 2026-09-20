package com.orderflow.inventory.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Typed view of the {@code inventory.*} block in application.yml (every value
 * of which is an environment variable). Ranges were already checked by
 * {@link ConfigGuard}; this record just makes them convenient to inject.
 */
@ConfigurationProperties(prefix = "inventory")
public record InventoryProperties(
        String dbName,
        long holdDurationMs,
        long lockTimeoutMs,
        int reserveMaxItems,
        int maxQuantityPerItem,
        int bulkLookupMaxIds,
        Sweeper sweeper,
        Kafka kafka,
        Seed seed) {

    public Duration holdDuration() {
        return Duration.ofMillis(holdDurationMs);
    }

    public record Sweeper(boolean enabled, long intervalMs, int batchSize) {
    }

    public record Kafka(
            boolean consumerEnabled,
            String orderEventsTopic,
            String inventoryEventsTopic,
            String deadLetterTopic,
            String consumerGroup,
            Retry retry) {
    }

    public record Retry(int maxAttempts, long initialIntervalMs, double multiplier, long maxIntervalMs) {
    }

    public record Seed(boolean enabled, String catalogUrl) {
    }
}
