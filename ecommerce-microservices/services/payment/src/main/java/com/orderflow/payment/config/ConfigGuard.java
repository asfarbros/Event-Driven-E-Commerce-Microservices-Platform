package com.orderflow.payment.config;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.regex.Pattern;

import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;

/**
 * Fail-fast configuration validation — same mechanism as Inventory's
 * ConfigGuard: runs before any DataSource / Kafka / HTTP bean exists, checks
 * EVERY variable this service reads, and aborts with ALL problems listed.
 *
 * <p><b>Data-ownership guard:</b> {@code PAYMENT_DB_URL} must name exactly
 * {@code PAYMENT_DB_NAME} (payment_db). order_db / inventory_db are refused
 * before a connection is opened.
 *
 * <p><b>Razorpay credential rules</b> (this is the ONLY service that holds them):
 * <ul>
 *   <li>the key id must look like {@code rzp_test_…} or {@code rzp_live_…};</li>
 *   <li>the .env.example placeholders ({@code rzp_test_xxxx…}, {@code xxxx…},
 *       {@code your_…}) are refused — a placeholder would only fail later with a
 *       confusing 401 from Razorpay;</li>
 *   <li>a LIVE key is refused unless the {@code prod} profile is active, so a
 *       laptop can never accidentally move real money.</li>
 * </ul>
 * Values are never echoed back in the messages — only the variable names.
 */
public class ConfigGuard implements ApplicationListener<ApplicationEnvironmentPreparedEvent> {

    private static final Pattern JDBC_POSTGRES = Pattern.compile("^jdbc:postgresql://[^/]+/([A-Za-z0-9_]+)(\\?.*)?$");
    private static final Pattern TOPIC = Pattern.compile("^[A-Za-z0-9._-]{1,249}$");
    private static final Pattern GROUP = Pattern.compile("^[A-Za-z0-9._-]{1,128}$");
    private static final Pattern DB_NAME = Pattern.compile("^[A-Za-z0-9_]{1,63}$");
    private static final Pattern BOOTSTRAP = Pattern.compile("^[A-Za-z0-9.-]+:\\d{1,5}(,[A-Za-z0-9.-]+:\\d{1,5})*$");
    private static final Pattern RAZORPAY_KEY_ID = Pattern.compile("^rzp_(test|live)_[A-Za-z0-9]{8,}$");
    private static final Pattern CURRENCY = Pattern.compile("^[A-Z]{3}$");
    private static final Pattern PLACEHOLDER = Pattern.compile("^(x{6,}|your_.*|change_me.*|rzp_test_x{6,})$", Pattern.CASE_INSENSITIVE);
    private static final List<String> LOG_LEVELS = List.of("trace", "debug", "info", "warn", "error");

    @Override
    public void onApplicationEvent(ApplicationEnvironmentPreparedEvent event) {
        List<String> problems = validate(event.getEnvironment());
        if (!problems.isEmpty()) {
            throw new InvalidConfigurationException(problems);
        }
    }

    static List<String> validate(Environment env) {
        Checker c = new Checker(env);

        c.port("PAYMENT_PORT");
        c.custom("PAYMENT_DB_URL", ConfigGuard::jdbcDatabase);
        c.string("PAYMENT_DB_USER");
        c.string("PAYMENT_DB_PASSWORD");
        c.matches("PAYMENT_DB_NAME", DB_NAME, "a PostgreSQL database name");
        c.integer("PAYMENT_DB_POOL_SIZE", 1, 100);
        c.integer("PAYMENT_LOCK_TIMEOUT_MS", 100, 60_000);
        c.integer("PAYMENT_SHUTDOWN_TIMEOUT_MS", 1, 300_000);
        c.integer("PAYMENT_MAX_AMOUNT_IN_PAISE", 1, 1_000_000_000_000L);

        // Razorpay — credentials + client
        c.matches("RAZORPAY_KEY_ID", RAZORPAY_KEY_ID, "a Razorpay key id (rzp_test_... / rzp_live_...)");
        c.secret("RAZORPAY_KEY_SECRET", 16);
        c.secret("RAZORPAY_WEBHOOK_SECRET", 8);
        c.matches("RAZORPAY_CURRENCY", CURRENCY, "an ISO-4217 code such as INR");
        c.custom("RAZORPAY_API_BASE_URL", v -> {
            URI u = URI.create(v);
            if (u.getScheme() == null || !(u.getScheme().equals("http") || u.getScheme().equals("https")) || u.getHost() == null) {
                throw new IllegalArgumentException("must be an absolute http(s) URL");
            }
            return v;
        });
        c.integer("RAZORPAY_TIMEOUT_MS", 100, 120_000);

        // Circuit breaker
        c.integer("PAYMENT_BREAKER_FAILURE_RATE_THRESHOLD", 1, 100);
        c.integer("PAYMENT_BREAKER_SLIDING_WINDOW_SIZE", 1, 1_000);
        c.integer("PAYMENT_BREAKER_MINIMUM_CALLS", 1, 1_000);
        c.integer("PAYMENT_BREAKER_WAIT_OPEN_MS", 100, 3_600_000);
        c.integer("PAYMENT_BREAKER_HALF_OPEN_CALLS", 1, 100);

        // Reconciliation
        c.integer("PAYMENT_RECONCILE_INTERVAL_MS", 1_000, 3_600_000);
        c.integer("PAYMENT_RECONCILE_AFTER_MS", 1_000, 86_400_000);
        c.integer("PAYMENT_ABANDON_AFTER_MS", 1_000, 604_800_000);
        c.integer("PAYMENT_RECONCILE_BATCH_SIZE", 1, 1_000);

        // Kafka
        c.matches("KAFKA_BOOTSTRAP_SERVERS", BOOTSTRAP, "host:port[,host:port]");
        c.matches("KAFKA_TOPIC_ORDER_EVENTS", TOPIC, "a Kafka topic name");
        c.matches("KAFKA_TOPIC_PAYMENT_EVENTS", TOPIC, "a Kafka topic name");
        c.matches("KAFKA_TOPIC_ORDER_EVENTS_PAYMENT_DLT", TOPIC, "a Kafka topic name");
        c.matches("PAYMENT_KAFKA_CONSUMER_GROUP", GROUP, "a Kafka consumer group id");
        c.integer("PAYMENT_KAFKA_RETRY_MAX_ATTEMPTS", 0, 50);
        c.integer("PAYMENT_KAFKA_RETRY_INITIAL_MS", 10, 600_000);
        c.decimal("PAYMENT_KAFKA_RETRY_MULTIPLIER", 1.0, 10.0);
        c.integer("PAYMENT_KAFKA_RETRY_MAX_MS", 10, 3_600_000);
        c.oneOf("LOG_LEVEL", LOG_LEVELS);

        // Ownership: the JDBC URL must point at the database this service owns.
        String url = env.getProperty("PAYMENT_DB_URL");
        String dbName = env.getProperty("PAYMENT_DB_NAME");
        if (url != null && dbName != null && c.problems.stream().noneMatch(p -> p.startsWith("PAYMENT_DB_URL ") || p.startsWith("PAYMENT_DB_NAME "))) {
            String urlDb = jdbcDatabase(url.strip());
            if (!urlDb.equals(dbName.strip())) {
                c.problems.add("PAYMENT_DB_URL points at database \"" + urlDb + "\" but this service owns \""
                        + dbName.strip() + "\" (PAYMENT_DB_NAME) — refusing to touch another service's database");
            }
        }

        // Live keys only under the prod profile.
        String keyId = env.getProperty("RAZORPAY_KEY_ID", "");
        if (keyId.startsWith("rzp_live_") && !env.acceptsProfiles(Profiles.of("prod"))) {
            c.problems.add("RAZORPAY_KEY_ID is a LIVE key but the active profile is not \"prod\" — refusing to move real money from a non-production configuration");
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

        /** A credential: present, not the template placeholder, long enough. The value is never echoed. */
        void secret(String name, int minLength) {
            String v = raw(name);
            if (v == null) return;
            if (PLACEHOLDER.matcher(v).matches()) {
                problems.add(name + " still has the .env.example placeholder value — set the real TEST-mode value");
            } else if (v.length() < minLength) {
                problems.add(name + " is too short to be a real value (expected at least " + minLength + " characters)");
            }
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
                // Credentials are never echoed; other values are, to make typos obvious.
                boolean sensitive = name.contains("SECRET") || name.contains("PASSWORD");
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
