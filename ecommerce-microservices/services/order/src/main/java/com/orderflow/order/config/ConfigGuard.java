package com.orderflow.order.config;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.regex.Pattern;

import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.Environment;

/**
 * Fail-fast configuration validation — same mechanism as Inventory and
 * Payment: runs before any bean exists, checks EVERY variable this service
 * reads, aborts with ALL problems listed.
 *
 * <p><b>Data-ownership guard:</b> {@code ORDER_DB_URL} must name exactly
 * {@code ORDER_DB_NAME} (order_db); inventory_db / payment_db are refused
 * before a connection is opened.
 */
public class ConfigGuard implements ApplicationListener<ApplicationEnvironmentPreparedEvent> {

    private static final Pattern JDBC_POSTGRES = Pattern.compile("^jdbc:postgresql://[^/]+/([A-Za-z0-9_]+)(\\?.*)?$");
    private static final Pattern TOPIC = Pattern.compile("^[A-Za-z0-9._-]{1,249}$");
    private static final Pattern GROUP = Pattern.compile("^[A-Za-z0-9._-]{1,128}$");
    private static final Pattern DB_NAME = Pattern.compile("^[A-Za-z0-9_]{1,63}$");
    private static final Pattern BOOTSTRAP = Pattern.compile("^[A-Za-z0-9.-]+:\\d{1,5}(,[A-Za-z0-9.-]+:\\d{1,5})*$");
    private static final Pattern AMQP_NAME = Pattern.compile("^[A-Za-z0-9._-]{1,255}$");
    private static final List<String> LOG_LEVELS = List.of("trace", "debug", "info", "warn", "error");
    private static final List<String> PRICE_POLICIES = List.of("proceed", "reject");

    @Override
    public void onApplicationEvent(ApplicationEnvironmentPreparedEvent event) {
        List<String> problems = validate(event.getEnvironment());
        if (!problems.isEmpty()) {
            throw new InvalidConfigurationException(problems);
        }
    }

    static List<String> validate(Environment env) {
        Checker c = new Checker(env);

        c.port("ORDER_PORT");
        c.custom("ORDER_DB_URL", ConfigGuard::jdbcDatabase);
        c.string("ORDER_DB_USER");
        c.string("ORDER_DB_PASSWORD");
        c.matches("ORDER_DB_NAME", DB_NAME, "a PostgreSQL database name");
        c.integer("ORDER_DB_POOL_SIZE", 1, 100);
        c.integer("ORDER_LOCK_TIMEOUT_MS", 100, 60_000);
        c.integer("ORDER_SHUTDOWN_TIMEOUT_MS", 1, 300_000);
        c.oneOf("ORDER_PRICE_CHANGE_POLICY", PRICE_POLICIES);
        c.integer("ORDER_PAGE_LIMIT_DEFAULT", 1, 500);
        c.integer("ORDER_PAGE_LIMIT_MAX", 1, 500);

        // Downstream services (direct, never via the gateway)
        for (String url : List.of("CART_SERVICE_URL", "CATALOG_SERVICE_URL", "INVENTORY_SERVICE_URL", "PAYMENT_SERVICE_URL")) {
            c.custom(url, ConfigGuard::httpUrl);
        }
        c.integer("ORDER_CART_TIMEOUT_MS", 100, 120_000);
        c.integer("ORDER_CATALOG_TIMEOUT_MS", 100, 120_000);
        c.integer("ORDER_INVENTORY_TIMEOUT_MS", 100, 120_000);
        c.integer("ORDER_PAYMENT_TIMEOUT_MS", 100, 120_000);
        c.integer("ORDER_BREAKER_FAILURE_RATE_THRESHOLD", 1, 100);
        c.integer("ORDER_BREAKER_SLIDING_WINDOW_SIZE", 1, 1_000);
        c.integer("ORDER_BREAKER_MINIMUM_CALLS", 1, 1_000);
        c.integer("ORDER_BREAKER_WAIT_OPEN_MS", 100, 3_600_000);
        c.integer("ORDER_BREAKER_HALF_OPEN_CALLS", 1, 100);

        // Outbox + reconciliation
        c.integer("ORDER_OUTBOX_RELAY_INTERVAL_MS", 100, 600_000);
        c.integer("ORDER_OUTBOX_BATCH_SIZE", 1, 1_000);
        c.integer("ORDER_RECONCILE_INTERVAL_MS", 1_000, 3_600_000);
        c.integer("ORDER_RECONCILE_AFTER_MS", 1_000, 86_400_000);
        c.integer("ORDER_ABANDON_AFTER_MS", 1_000, 604_800_000);
        c.integer("ORDER_RECONCILE_BATCH_SIZE", 1, 1_000);

        // Kafka
        c.matches("KAFKA_BOOTSTRAP_SERVERS", BOOTSTRAP, "host:port[,host:port]");
        for (String t : List.of("KAFKA_TOPIC_ORDER_EVENTS", "KAFKA_TOPIC_PAYMENT_EVENTS", "KAFKA_TOPIC_INVENTORY_EVENTS",
                "KAFKA_TOPIC_PAYMENT_EVENTS_ORDER_DLT", "KAFKA_TOPIC_INVENTORY_EVENTS_ORDER_DLT")) {
            c.matches(t, TOPIC, "a Kafka topic name");
        }
        c.matches("ORDER_KAFKA_CONSUMER_GROUP", GROUP, "a Kafka consumer group id");
        c.integer("ORDER_KAFKA_RETRY_MAX_ATTEMPTS", 0, 50);
        c.integer("ORDER_KAFKA_RETRY_INITIAL_MS", 10, 600_000);
        c.decimal("ORDER_KAFKA_RETRY_MULTIPLIER", 1.0, 10.0);
        c.integer("ORDER_KAFKA_RETRY_MAX_MS", 10, 3_600_000);

        // RabbitMQ
        c.custom("RABBITMQ_URL", v -> {
            URI u = URI.create(v);
            if (u.getScheme() == null || !(u.getScheme().equals("amqp") || u.getScheme().equals("amqps")) || u.getHost() == null) {
                throw new IllegalArgumentException("must be an amqp(s):// URL");
            }
            return v;
        });
        for (String n : List.of("RABBITMQ_NOTIFICATION_EXCHANGE", "RABBITMQ_NOTIFICATION_QUEUE",
                "RABBITMQ_NOTIFICATION_DLX", "RABBITMQ_NOTIFICATION_DLQ")) {
            c.matches(n, AMQP_NAME, "an AMQP name");
        }
        c.integer("ORDER_RABBITMQ_CONFIRM_TIMEOUT_MS", 100, 60_000);
        c.oneOf("LOG_LEVEL", LOG_LEVELS);

        // Ownership: the JDBC URL must point at the database this service owns.
        String url = env.getProperty("ORDER_DB_URL");
        String dbName = env.getProperty("ORDER_DB_NAME");
        if (url != null && dbName != null && c.problems.stream().noneMatch(p -> p.startsWith("ORDER_DB_URL ") || p.startsWith("ORDER_DB_NAME "))) {
            String urlDb = jdbcDatabase(url.strip());
            if (!urlDb.equals(dbName.strip())) {
                c.problems.add("ORDER_DB_URL points at database \"" + urlDb + "\" but this service owns \""
                        + dbName.strip() + "\" (ORDER_DB_NAME) — refusing to touch another service's database");
            }
        }
        return c.problems;
    }

    static String jdbcDatabase(String url) {
        var m = JDBC_POSTGRES.matcher(url);
        if (!m.matches()) {
            throw new IllegalArgumentException("must look like jdbc:postgresql://host:port/database");
        }
        return m.group(1);
    }

    static String httpUrl(String v) {
        URI u = URI.create(v);
        if (u.getScheme() == null || !(u.getScheme().equals("http") || u.getScheme().equals("https")) || u.getHost() == null) {
            throw new IllegalArgumentException("must be an absolute http(s) URL");
        }
        return v;
    }

    private static final class Checker {
        private final Environment env;
        private final List<String> problems = new ArrayList<>();

        Checker(Environment env) {
            this.env = env;
        }

        private String raw(String name) {
            String v = env.getProperty(name);
            if (v == null || v.isBlank()) {
                problems.add(name + " is required but missing or empty");
                return null;
            }
            return v.strip();
        }

        void string(String name) {
            raw(name);
        }

        void port(String name) {
            integer(name, 1, 65_535);
        }

        void integer(String name, long min, long max) {
            String v = raw(name);
            if (v == null) return;
            if (!v.matches("\\d{1,15}")) {
                problems.add(name + " must be a whole number (got \"" + v + "\")");
                return;
            }
            long n = Long.parseLong(v);
            if (n < min || n > max) {
                problems.add(name + " must be between " + min + " and " + max + " (got " + n + ")");
            }
        }

        void decimal(String name, double min, double max) {
            String v = raw(name);
            if (v == null) return;
            try {
                double d = Double.parseDouble(v);
                if (d < min || d > max) {
                    problems.add(name + " must be between " + min + " and " + max + " (got " + v + ")");
                }
            } catch (NumberFormatException e) {
                problems.add(name + " must be a number (got \"" + v + "\")");
            }
        }

        void matches(String name, Pattern pattern, String description) {
            String v = raw(name);
            if (v != null && !pattern.matcher(v).matches()) {
                boolean sensitive = name.contains("SECRET") || name.contains("PASSWORD") || name.endsWith("_URL");
                problems.add(name + " must be " + description + (sensitive ? "" : " (got \"" + v + "\")"));
            }
        }

        void oneOf(String name, List<String> values) {
            String v = raw(name);
            if (v != null && !values.contains(v.toLowerCase())) {
                problems.add(name + " must be one of " + String.join(", ", values) + " (got \"" + v + "\")");
            }
        }

        void custom(String name, Function<String, ?> parser) {
            String v = raw(name);
            if (v == null) return;
            try {
                parser.apply(v);
            } catch (RuntimeException e) {
                problems.add(name + " " + e.getMessage());
            }
        }
    }
}
