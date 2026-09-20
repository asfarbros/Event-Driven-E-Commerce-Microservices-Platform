package com.orderflow.payment.config;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.core.env.MapPropertySource;
import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.assertThat;

class ConfigGuardTest {

    private static Map<String, Object> valid() {
        Map<String, Object> m = new HashMap<>();
        m.put("PAYMENT_PORT", "8083");
        m.put("PAYMENT_DB_URL", "jdbc:postgresql://localhost:5432/payment_db");
        m.put("PAYMENT_DB_USER", "payment_user");
        m.put("PAYMENT_DB_PASSWORD", "secret");
        m.put("PAYMENT_DB_NAME", "payment_db");
        m.put("PAYMENT_DB_POOL_SIZE", "10");
        m.put("PAYMENT_LOCK_TIMEOUT_MS", "8000");
        m.put("PAYMENT_SHUTDOWN_TIMEOUT_MS", "10000");
        m.put("PAYMENT_MAX_AMOUNT_IN_PAISE", "10000000");
        m.put("RAZORPAY_KEY_ID", "rzp_test_Abcdef1234567890");
        m.put("RAZORPAY_KEY_SECRET", "a-real-looking-secret-value-123");
        m.put("RAZORPAY_WEBHOOK_SECRET", "webhook-secret-value");
        m.put("RAZORPAY_CURRENCY", "INR");
        m.put("RAZORPAY_API_BASE_URL", "https://api.razorpay.com/v1");
        m.put("RAZORPAY_TIMEOUT_MS", "5000");
        m.put("PAYMENT_BREAKER_FAILURE_RATE_THRESHOLD", "50");
        m.put("PAYMENT_BREAKER_SLIDING_WINDOW_SIZE", "10");
        m.put("PAYMENT_BREAKER_MINIMUM_CALLS", "4");
        m.put("PAYMENT_BREAKER_WAIT_OPEN_MS", "10000");
        m.put("PAYMENT_BREAKER_HALF_OPEN_CALLS", "2");
        m.put("PAYMENT_RECONCILE_INTERVAL_MS", "30000");
        m.put("PAYMENT_RECONCILE_AFTER_MS", "120000");
        m.put("PAYMENT_ABANDON_AFTER_MS", "1800000");
        m.put("PAYMENT_RECONCILE_BATCH_SIZE", "50");
        m.put("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092");
        m.put("KAFKA_TOPIC_ORDER_EVENTS", "order-events");
        m.put("KAFKA_TOPIC_PAYMENT_EVENTS", "payment-events");
        m.put("KAFKA_TOPIC_ORDER_EVENTS_PAYMENT_DLT", "order-events.payment.dlt");
        m.put("PAYMENT_KAFKA_CONSUMER_GROUP", "payment-service");
        m.put("PAYMENT_KAFKA_RETRY_MAX_ATTEMPTS", "3");
        m.put("PAYMENT_KAFKA_RETRY_INITIAL_MS", "1000");
        m.put("PAYMENT_KAFKA_RETRY_MULTIPLIER", "2.0");
        m.put("PAYMENT_KAFKA_RETRY_MAX_MS", "10000");
        m.put("LOG_LEVEL", "debug");
        return m;
    }

    private static List<String> validate(Map<String, Object> values, String... profiles) {
        MockEnvironment env = new MockEnvironment();
        env.getPropertySources().addFirst(new MapPropertySource("test", values));
        env.setActiveProfiles(profiles);
        return ConfigGuard.validate(env);
    }

    @Test
    void acceptsACompleteConfiguration() {
        assertThat(validate(valid())).isEmpty();
    }

    @Test
    void refusesAnotherServicesDatabase() {
        Map<String, Object> m = valid();
        m.put("PAYMENT_DB_URL", "jdbc:postgresql://localhost:5432/inventory_db");
        assertThat(validate(m)).singleElement().asString().contains("points at database \"inventory_db\"").contains("owns \"payment_db\"");
    }

    @Test
    void refusesTemplatePlaceholdersForSecretsWithoutEchoingThem() {
        Map<String, Object> m = valid();
        m.put("RAZORPAY_KEY_SECRET", "xxxxxxxxxxxxxxxxxxxxxxxx");
        m.put("RAZORPAY_WEBHOOK_SECRET", "xxxxxxxxxxxxxxxx");
        List<String> problems = validate(m);
        assertThat(problems).hasSize(2).allMatch(p -> p.contains("placeholder"));
        assertThat(problems).noneMatch(p -> p.contains("xxxxxxxx"));
    }

    @Test
    void refusesMalformedKeyIdAndLiveKeysOutsideProd() {
        Map<String, Object> m = valid();
        m.put("RAZORPAY_KEY_ID", "sk_test_notrazorpay");
        assertThat(validate(m)).singleElement().asString().startsWith("RAZORPAY_KEY_ID must be a Razorpay key id");

        m.put("RAZORPAY_KEY_ID", "rzp_live_Abcdef1234567890");
        assertThat(validate(m, "local")).singleElement().asString().contains("LIVE key");
        assertThat(validate(m, "prod")).isEmpty();
    }

    @Test
    void reportsEveryProblemAtOnce() {
        Map<String, Object> m = valid();
        m.remove("PAYMENT_PORT");
        m.put("RAZORPAY_TIMEOUT_MS", "soon");
        m.put("RAZORPAY_API_BASE_URL", "not a url");
        m.put("RAZORPAY_CURRENCY", "rupees");
        assertThat(validate(m)).hasSize(4);
    }
}
