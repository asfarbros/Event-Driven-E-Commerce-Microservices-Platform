package com.orderflow.order.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Typed view of the {@code order.*} block (every value an env var, ranges checked by {@link ConfigGuard}). */
@ConfigurationProperties(prefix = "order")
public record OrderProperties(
        String dbName,
        PriceChangePolicy priceChangePolicy,
        int pageLimitDefault,
        int pageLimitMax,
        Clients clients,
        Breaker breaker,
        Outbox outbox,
        Reconciliation reconciliation,
        Kafka kafka,
        Rabbit rabbit) {

    /** What to do when Catalog's fresh price differs from the cart's priced snapshot. */
    public enum PriceChangePolicy { PROCEED, REJECT }

    public record Clients(String cartUrl, String catalogUrl, String inventoryUrl, String paymentUrl,
                          long cartTimeoutMs, long catalogTimeoutMs, long inventoryTimeoutMs, long paymentTimeoutMs) {
    }

    public record Breaker(int failureRateThreshold, int slidingWindowSize, int minimumCalls, long waitInOpenMs, int halfOpenCalls) {
    }

    public record Outbox(boolean enabled, long relayIntervalMs, int batchSize) {
    }

    public record Reconciliation(boolean enabled, long intervalMs, long stuckAfterMs, long abandonAfterMs, int batchSize) {
    }

    public record Kafka(boolean consumerEnabled, String orderEventsTopic, String paymentEventsTopic, String inventoryEventsTopic,
                        String paymentEventsDlt, String inventoryEventsDlt, String consumerGroup, Retry retry) {
    }

    public record Retry(int maxAttempts, long initialIntervalMs, double multiplier, long maxIntervalMs) {
    }

    public record Rabbit(String exchange, String queue, String deadLetterExchange, String deadLetterQueue, long confirmTimeoutMs) {
    }
}
