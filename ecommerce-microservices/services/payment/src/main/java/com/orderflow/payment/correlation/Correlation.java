package com.orderflow.payment.correlation;

import java.util.UUID;
import java.util.regex.Pattern;

import org.slf4j.MDC;

/**
 * The correlation id that follows one user action across REST and Kafka hops.
 *
 * <ul>
 *   <li>HTTP: read from the {@code X-Request-Id} request header (the gateway
 *       always sets it) or minted here; echoed in the response header.</li>
 *   <li>Logs: stored in the MDC under {@code requestId}, so every JSON log line
 *       written while the request / event / sweep is being handled carries it.</li>
 *   <li>Kafka: written to the {@code X-Request-Id} record header on publish and
 *       read back out of it on consume.</li>
 * </ul>
 */
public final class Correlation {

    /** Header name — identical on HTTP and on Kafka records. */
    public static final String HEADER = "X-Request-Id";
    /** MDC key — identical to the field name the Node services log. */
    public static final String MDC_KEY = "requestId";

    private static final Pattern VALID = Pattern.compile("^[A-Za-z0-9._-]{1,128}$");

    private Correlation() {
    }

    public static boolean isValid(String value) {
        return value != null && VALID.matcher(value).matches();
    }

    public static String newId() {
        return UUID.randomUUID().toString();
    }

    /** A fresh id with a recognisable prefix for work that no request started (e.g. the sweeper). */
    public static String newId(String prefix) {
        return prefix + "-" + UUID.randomUUID().toString().substring(0, 8);
    }

    /** The current id, or a new one if this thread is not handling anything correlated yet. */
    public static String current() {
        String id = MDC.get(MDC_KEY);
        if (id == null) {
            id = newId();
            MDC.put(MDC_KEY, id);
        }
        return id;
    }

    public static void set(String id) {
        MDC.put(MDC_KEY, id);
    }

    public static void clear() {
        MDC.remove(MDC_KEY);
    }
}
