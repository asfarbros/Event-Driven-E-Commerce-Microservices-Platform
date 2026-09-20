package com.orderflow.inventory.config;

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
        m.put("INVENTORY_PORT", "8082");
        m.put("INVENTORY_DB_URL", "jdbc:postgresql://localhost:5432/inventory_db");
        m.put("INVENTORY_DB_USER", "inventory_user");
        m.put("INVENTORY_DB_PASSWORD", "secret");
        m.put("INVENTORY_DB_NAME", "inventory_db");
        m.put("INVENTORY_DB_POOL_SIZE", "10");
        m.put("INVENTORY_LOCK_TIMEOUT_MS", "3000");
        m.put("INVENTORY_HOLD_DURATION_MS", "600000");
        m.put("INVENTORY_SWEEPER_INTERVAL_MS", "15000");
        m.put("INVENTORY_SWEEPER_BATCH_SIZE", "100");
        m.put("INVENTORY_RESERVE_MAX_ITEMS", "50");
        m.put("INVENTORY_MAX_QUANTITY_PER_ITEM", "1000");
        m.put("INVENTORY_BULK_LOOKUP_MAX_IDS", "200");
        m.put("INVENTORY_SHUTDOWN_TIMEOUT_MS", "10000");
        m.put("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092");
        m.put("KAFKA_TOPIC_ORDER_EVENTS", "order-events");
        m.put("KAFKA_TOPIC_INVENTORY_EVENTS", "inventory-events");
        m.put("KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT", "order-events.inventory.dlt");
        m.put("INVENTORY_KAFKA_CONSUMER_GROUP", "inventory-service");
        m.put("INVENTORY_KAFKA_RETRY_MAX_ATTEMPTS", "3");
        m.put("INVENTORY_KAFKA_RETRY_INITIAL_MS", "1000");
        m.put("INVENTORY_KAFKA_RETRY_MULTIPLIER", "2.0");
        m.put("INVENTORY_KAFKA_RETRY_MAX_MS", "10000");
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
    void reportsEveryProblemAtOnce() {
        Map<String, Object> m = valid();
        m.remove("INVENTORY_PORT");
        m.put("INVENTORY_LOCK_TIMEOUT_MS", "abc");
        m.put("INVENTORY_KAFKA_CONSUMER_GROUP", "  ");
        m.put("LOG_LEVEL", "loud");

        List<String> problems = validate(m);

        assertThat(problems).hasSize(4);
        assertThat(problems).anyMatch(p -> p.startsWith("INVENTORY_PORT is required"));
        assertThat(problems).anyMatch(p -> p.startsWith("INVENTORY_LOCK_TIMEOUT_MS must be a whole number"));
        assertThat(problems).anyMatch(p -> p.startsWith("INVENTORY_KAFKA_CONSUMER_GROUP is required"));
        assertThat(problems).anyMatch(p -> p.startsWith("LOG_LEVEL must be one of"));
    }

    @Test
    void refusesAnotherServicesDatabase() {
        Map<String, Object> m = valid();
        m.put("INVENTORY_DB_URL", "jdbc:postgresql://localhost:5432/order_db");

        assertThat(validate(m)).singleElement().asString()
                .contains("points at database \"order_db\"").contains("owns \"inventory_db\"");
    }

    @Test
    void refusesUrlsThatAreNotPostgres() {
        Map<String, Object> m = valid();
        m.put("INVENTORY_DB_URL", "jdbc:mysql://localhost:3306/inventory_db");

        assertThat(validate(m)).singleElement().asString().startsWith("INVENTORY_DB_URL must look like jdbc:postgresql://");
    }

    @Test
    void enforcesRanges() {
        Map<String, Object> m = valid();
        m.put("INVENTORY_HOLD_DURATION_MS", "10");
        m.put("INVENTORY_KAFKA_RETRY_MULTIPLIER", "0.5");

        assertThat(validate(m)).hasSize(2).allMatch(p -> p.contains("must be between"));
    }
}
