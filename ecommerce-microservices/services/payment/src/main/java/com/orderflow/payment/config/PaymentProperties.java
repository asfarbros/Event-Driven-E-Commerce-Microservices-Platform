package com.orderflow.payment.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Typed view of the {@code payment.*} block in application.yml (every value an
 * environment variable, already range-checked by {@link ConfigGuard}).
 * {@link Razorpay#keySecret()} and {@link Razorpay#webhookSecret()} are the
 * only in-memory copies of the credentials; nothing ever logs or serialises
 * this record.
 */
@ConfigurationProperties(prefix = "payment")
public record PaymentProperties(
        String dbName,
        String defaultCurrency,
        long maxAmountInPaise,
        Razorpay razorpay,
        Breaker breaker,
        Reconciliation reconciliation,
        Kafka kafka) {

    public record Razorpay(String keyId, String keySecret, String webhookSecret, String baseUrl, long timeoutMs) {
        public Duration timeout() {
            return Duration.ofMillis(timeoutMs);
        }

        public boolean isTestMode() {
            return keyId != null && keyId.startsWith("rzp_test_");
        }

        @Override
        public String toString() {
            return "Razorpay[keyId=" + keyId + ", baseUrl=" + baseUrl + ", timeoutMs=" + timeoutMs + ", secrets=[redacted]]";
        }
    }

    public record Breaker(int failureRateThreshold, int slidingWindowSize, int minimumCalls, long waitInOpenMs, int halfOpenCalls) {
    }

    public record Reconciliation(boolean enabled, long intervalMs, long stuckAfterMs, long abandonAfterMs, int batchSize) {
    }

    public record Kafka(boolean consumerEnabled, String orderEventsTopic, String paymentEventsTopic, String deadLetterTopic,
                        String consumerGroup, Retry retry) {
    }

    public record Retry(int maxAttempts, long initialIntervalMs, double multiplier, long maxIntervalMs) {
    }
}
