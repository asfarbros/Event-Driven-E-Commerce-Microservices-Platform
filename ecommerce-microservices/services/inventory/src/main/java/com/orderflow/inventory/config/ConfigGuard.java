package com.orderflow.inventory.config;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.regex.Pattern;

import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.Environment;

/**
 * Fail-fast configuration validation — the Java twin of
 * {@code services/cart/src/config/env.js}. Runs as soon as the environment is
 * assembled (before any DataSource, Flyway or Kafka bean is created), checks
 * EVERY variable this service reads, and aborts start-up with a list of ALL
 * problems at once instead of dying on the first missing value.
 *
 * <p><b>Data-ownership guard:</b> {@code INVENTORY_DB_URL} must name exactly the
 * database in {@code INVENTORY_DB_NAME} (inventory_db). This service owns that
 * database and nothing else; pointing it at order_db or payment_db is refused
 * before a single connection is opened. Catalog and Cart apply the same rule to
 * their Mongo URIs.
 *
 * Registered in {@code META-INF/spring.factories}; the failure is rendered by
 * {@link InvalidConfigurationFailureAnalyzer}.
 */
public class ConfigGuard implements ApplicationListener<ApplicationEnvironmentPreparedEvent> {

    private static final Pattern JDBC_POSTGRES = Pattern.compile("^jdbc:postgresql://[^/]+/([A-Za-z0-9_]+)(\\?.*)?$");
    private static final Pattern TOPIC = Pattern.compile("^[A-Za-z0-9._-]{1,249}$");
    private static final Pattern GROUP = Pattern.compile("^[A-Za-z0-9._-]{1,128}$");
    private static final Pattern DB_NAME = Pattern.compile("^[A-Za-z0-9_]{1,63}$");
    private static final Pattern BOOTSTRAP = Pattern.compile("^[A-Za-z0-9.-]+:\\d{1,5}(,[A-Za-z0-9.-]+:\\d{1,5})*$");
    private static final List<String> LOG_LEVELS = List.of("trace", "debug", "info", "warn", "error");

    @Override
    public void onApplicationEvent(ApplicationEnvironmentPreparedEvent event) {
        List<String> problems = validate(event.getEnvironment());
        if (!problems.isEmpty()) {
            throw new InvalidConfigurationException(problems);
        }
    }

    /** Package-private so the unit test can drive it with a fake environment. */
    static List<String> validate(Environment env) {
        Checker c = new Checker(env);

        c.port("INVENTORY_PORT");
        c.custom("INVENTORY_DB_URL", ConfigGuard::jdbcDatabase);
        c.string("INVENTORY_DB_USER");
        c.string("INVENTORY_DB_PASSWORD");
        c.matches("INVENTORY_DB_NAME", DB_NAME, "a PostgreSQL database name");
        c.integer("INVENTORY_DB_POOL_SIZE", 1, 100);
        c.integer("INVENTORY_LOCK_TIMEOUT_MS", 100, 60_000);
        c.integer("INVENTORY_HOLD_DURATION_MS", 1_000, 86_400_000);
        c.integer("INVENTORY_SWEEPER_INTERVAL_MS", 500, 3_600_000);
        c.integer("INVENTORY_SWEEPER_BATCH_SIZE", 1, 10_000);
        c.integer("INVENTORY_RESERVE_MAX_ITEMS", 1, 500);
        c.integer("INVENTORY_MAX_QUANTITY_PER_ITEM", 1, 1_000_000);
        c.integer("INVENTORY_BULK_LOOKUP_MAX_IDS", 1, 1_000);
        c.integer("INVENTORY_SHUTDOWN_TIMEOUT_MS", 1, 300_000);
        c.matches("KAFKA_BOOTSTRAP_SERVERS", BOOTSTRAP, "host:port[,host:port]");
        c.matches("KAFKA_TOPIC_ORDER_EVENTS", TOPIC, "a Kafka topic name");
        c.matches("KAFKA_TOPIC_INVENTORY_EVENTS", TOPIC, "a Kafka topic name");
        c.matches("KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT", TOPIC, "a Kafka topic name");
        c.matches("INVENTORY_KAFKA_CONSUMER_GROUP", GROUP, "a Kafka consumer group id");
        c.integer("INVENTORY_KAFKA_RETRY_MAX_ATTEMPTS", 0, 50);
        c.integer("INVENTORY_KAFKA_RETRY_INITIAL_MS", 10, 600_000);
        c.decimal("INVENTORY_KAFKA_RETRY_MULTIPLIER", 1.0, 10.0);
        c.integer("INVENTORY_KAFKA_RETRY_MAX_MS", 10, 3_600_000);
        c.oneOf("LOG_LEVEL", LOG_LEVELS);

        // Seed mode additionally needs the Catalog base URL to fetch product ids.
        if (env.acceptsProfiles(org.springframework.core.env.Profiles.of("seed"))) {
            c.custom("CATALOG_SERVICE_URL", v -> {
                URI u = URI.create(v);
                if (u.getScheme() == null || !(u.getScheme().equals("http") || u.getScheme().equals("https")) || u.getHost() == null) {
                    throw new IllegalArgumentException("must be an absolute http(s) URL");
                }
                return v;
            });
        }

        // Ownership: the JDBC URL must point at the database this service owns.
        String url = env.getProperty("INVENTORY_DB_URL");
        String dbName = env.getProperty("INVENTORY_DB_NAME");
        if (url != null && dbName != null && c.problems.stream().noneMatch(p -> p.startsWith("INVENTORY_DB_URL ") || p.startsWith("INVENTORY_DB_NAME "))) {
            String urlDb = jdbcDatabase(url.strip());
            if (!urlDb.equals(dbName.strip())) {
                c.problems.add("INVENTORY_DB_URL points at database \"" + urlDb + "\" but this service owns \""
                        + dbName.strip() + "\" (INVENTORY_DB_NAME) — refusing to touch another service's database");
            }
        }
        return c.problems;
    }

    /** Extracts the database name from a jdbc:postgresql URL, or throws with a message. */
    static String jdbcDatabase(String url) {
        var m = JDBC_POSTGRES.matcher(url);
        if (!m.matches()) {
            throw new IllegalArgumentException("must look like jdbc:postgresql://host:port/database");
        }
        return m.group(1);
    }

    /** Collects problems for every variable instead of stopping at the first. */
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
            if (!v.matches("\\d{1,12}")) {
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
                problems.add(name + " must be " + description + " (got \"" + v + "\")");
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
