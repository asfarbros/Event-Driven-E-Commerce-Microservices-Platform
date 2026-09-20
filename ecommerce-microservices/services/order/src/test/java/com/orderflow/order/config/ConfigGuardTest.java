package com.orderflow.order.config;

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
        m.put("ORDER_PORT", "8081");
        m.put("ORDER_DB_URL", "jdbc:postgresql://localhost:5432/order_db");
        m.put("ORDER_DB_USER", "order_user");
        m.put("ORDER_DB_PASSWORD", "secret");
        m.put("ORDER_DB_NAME", "order_db");
        m.put("ORDER_DB_POOL_SIZE", "10");
        m.put("ORDER_LOCK_TIMEOUT_MS", "5000");
        m.put("ORDER_SHUTDOWN_TIMEOUT_MS", "10000");
        m.put("ORDER_PRICE_CHANGE_POLICY", "proceed");
        m.put("ORDER_PAGE_LIMIT_DEFAULT", "20");
        m.put("ORDER_PAGE_LIMIT_MAX", "100");
        m.put("CART_SERVICE_URL", "http://localhost:4002");
        m.put("CATALOG_SERVICE_URL", "http://localhost:4001");
        m.put("INVENTORY_SERVICE_URL", "http://localhost:8082");
        m.put("PAYMENT_SERVICE_URL", "http://localhost:8083");
        m.put("ORDER_CART_TIMEOUT_MS", "3000");
        m.put("ORDER_CATALOG_TIMEOUT_MS", "3000");
        m.put("ORDER_INVENTORY_TIMEOUT_MS", "5000");
        m.put("ORDER_PAYMENT_TIMEOUT_MS", "10000");
        m.put("ORDER_BREAKER_FAILURE_RATE_THRESHOLD", "50");
        m.put("ORDER_BREAKER_SLIDING_WINDOW_SIZE", "10");
        m.put("ORDER_BREAKER_MINIMUM_CALLS", "4");
        m.put("ORDER_BREAKER_WAIT_OPEN_MS", "10000");
        m.put("ORDER_BREAKER_HALF_OPEN_CALLS", "2");
        m.put("ORDER_OUTBOX_RELAY_INTERVAL_MS", "2000");
        m.put("ORDER_OUTBOX_BATCH_SIZE", "100");
        m.put("ORDER_RECONCILE_INTERVAL_MS", "30000");
        m.put("ORDER_RECONCILE_AFTER_MS", "120000");
        m.put("ORDER_ABANDON_AFTER_MS", "1800000");
        m.put("ORDER_RECONCILE_BATCH_SIZE", "50");
        m.put("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092");
        m.put("KAFKA_TOPIC_ORDER_EVENTS", "order-events");
        m.put("KAFKA_TOPIC_PAYMENT_EVENTS", "payment-events");
        m.put("KAFKA_TOPIC_INVENTORY_EVENTS", "inventory-events");
        m.put("KAFKA_TOPIC_PAYMENT_EVENTS_ORDER_DLT", "payment-events.order.dlt");
        m.put("KAFKA_TOPIC_INVENTORY_EVENTS_ORDER_DLT", "inventory-events.order.dlt");
        m.put("ORDER_KAFKA_CONSUMER_GROUP", "order-service");
        m.put("ORDER_KAFKA_RETRY_MAX_ATTEMPTS", "3");
        m.put("ORDER_KAFKA_RETRY_INITIAL_MS", "1000");
        m.put("ORDER_KAFKA_RETRY_MULTIPLIER", "2.0");
        m.put("ORDER_KAFKA_RETRY_MAX_MS", "10000");
        m.put("RABBITMQ_URL", "amqp://orderflow:pw@localhost:5672");
        m.put("RABBITMQ_NOTIFICATION_EXCHANGE", "notifications");
        m.put("RABBITMQ_NOTIFICATION_QUEUE", "notification.tasks");
        m.put("RABBITMQ_NOTIFICATION_DLX", "notifications.dlx");
        m.put("RABBITMQ_NOTIFICATION_DLQ", "notification.tasks.dlq");
        m.put("ORDER_RABBITMQ_CONFIRM_TIMEOUT_MS", "5000");
        m.put("LOG_LEVEL", "debug");
        return m;
    }

    private static List<String> validate(Map<String, Object> values) {
        MockEnvironment env = new MockEnvironment();
        env.getPropertySources().addFirst(new MapPropertySource("test", values));
        return ConfigGuard.validate(env);
    }

    @Test
    void acceptsACompleteConfiguration() {
        assertThat(validate(valid())).isEmpty();
    }

    @Test
    void refusesAnotherServicesDatabase() {
        Map<String, Object> m = valid();
        m.put("ORDER_DB_URL", "jdbc:postgresql://localhost:5432/payment_db");
        assertThat(validate(m)).singleElement().asString().contains("points at database \"payment_db\"").contains("owns \"order_db\"");
    }

    @Test
    void reportsEveryProblemAtOnceWithoutEchoingUrls() {
        Map<String, Object> m = valid();
        m.remove("CART_SERVICE_URL");
        m.put("ORDER_PRICE_CHANGE_POLICY", "maybe");
        m.put("RABBITMQ_URL", "http://not-amqp");
        m.put("ORDER_KAFKA_RETRY_MULTIPLIER", "0.1");
        List<String> problems = validate(m);
        assertThat(problems).hasSize(4);
        assertThat(problems).anyMatch(p -> p.startsWith("CART_SERVICE_URL is required"));
        assertThat(problems).anyMatch(p -> p.startsWith("ORDER_PRICE_CHANGE_POLICY must be one of proceed, reject"));
        assertThat(problems).anyMatch(p -> p.startsWith("RABBITMQ_URL must be an amqp"));
        assertThat(problems).noneMatch(p -> p.contains("not-amqp"));
    }
}
