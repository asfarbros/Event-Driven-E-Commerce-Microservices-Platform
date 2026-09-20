package com.orderflow.order.clients;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.List;
import java.util.function.Supplier;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Shared plumbing for the four downstream services (Cart, Catalog, Inventory,
 * Payment). Each subclass gets:
 * <ul>
 *   <li>a {@link RestClient} on the service's base URL with its own
 *       connect+read timeout (called DIRECTLY, never via the gateway);</li>
 *   <li>its OWN Resilience4j {@link CircuitBreaker}, named after the
 *       dependency, configured from {@code ORDER_BREAKER_*}; state transitions
 *       are logged at WARN and exposed on /health;</li>
 *   <li>the {@code X-Request-Id} correlation header on every call.</li>
 * </ul>
 *
 * Failure classification (drives both the breaker and the caller's fallback):
 * <ul>
 *   <li>{@link Unavailable} — no usable answer: timeout, connection refused,
 *       5xx, breaker OPEN. Counts as a breaker failure.</li>
 *   <li>{@link Rejected} — the service answered 4xx with its
 *       {@code { error, message, details }} body (cart empty, insufficient
 *       stock, validation…). The dependency is healthy: NOT a breaker failure.</li>
 * </ul>
 */
public abstract class ServiceClient {

    private static final Logger log = LoggerFactory.getLogger(ServiceClient.class);

    public static class Unavailable extends RuntimeException {
        private final String dependency;

        public Unavailable(String dependency, String message, Throwable cause) {
            super(message, cause);
            this.dependency = dependency;
        }

        public String getDependency() {
            return dependency;
        }
    }

    public static class Rejected extends RuntimeException {
        private final String dependency;
        private final int status;
        private final String code;
        private final JsonNode details;

        public Rejected(String dependency, int status, String code, String message, JsonNode details) {
            super(message);
            this.dependency = dependency;
            this.status = status;
            this.code = code;
            this.details = details;
        }

        public String getDependency() { return dependency; }
        public int getStatus() { return status; }
        public String getCode() { return code; }
        public JsonNode getDetails() { return details; }
    }

    protected final String name;
    protected final RestClient client;
    protected final ObjectMapper objectMapper;
    private final CircuitBreaker breaker;

    protected ServiceClient(String name, String baseUrl, long timeoutMs, OrderProperties.Breaker b, ObjectMapper objectMapper) {
        this.name = name;
        this.objectMapper = objectMapper;
        Duration timeout = Duration.ofMillis(timeoutMs);
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(timeout).build());
        factory.setReadTimeout(timeout);
        this.client = RestClient.builder()
                .baseUrl(baseUrl.replaceAll("/+$", ""))
                .requestFactory(factory)
                .defaultHeaders(h -> h.setAccept(List.of(org.springframework.http.MediaType.APPLICATION_JSON)))
                .build();

        CircuitBreakerConfig config = CircuitBreakerConfig.custom()
                .failureRateThreshold(b.failureRateThreshold())
                .slidingWindowType(CircuitBreakerConfig.SlidingWindowType.COUNT_BASED)
                .slidingWindowSize(b.slidingWindowSize())
                .minimumNumberOfCalls(b.minimumCalls())
                .waitDurationInOpenState(Duration.ofMillis(b.waitInOpenMs()))
                .permittedNumberOfCallsInHalfOpenState(b.halfOpenCalls())
                .automaticTransitionFromOpenToHalfOpenEnabled(true)
                .ignoreExceptions(Rejected.class)
                .build();
        this.breaker = CircuitBreaker.of(name, config);
        this.breaker.getEventPublisher()
                .onStateTransition(e -> log.warn("circuit breaker state changed", kv("dependency", name),
                        kv("from", e.getStateTransition().getFromState()), kv("to", e.getStateTransition().getToState()),
                        kv("failureRate", breaker.getMetrics().getFailureRate())))
                .onCallNotPermitted(e -> log.warn("call rejected — circuit breaker is OPEN", kv("dependency", name)));
    }

    /** Runs one request inside the breaker, translating transport / status failures. */
    protected JsonNode call(String operation, Supplier<JsonNode> request) {
        long started = System.nanoTime();
        try {
            JsonNode result = breaker.executeSupplier(() -> {
                try {
                    return request.get();
                } catch (RestClientResponseException e) {
                    throw translate(operation, e);
                } catch (ResourceAccessException e) {
                    throw new Unavailable(name, name + " " + operation + ": " + rootMessage(e), e);
                }
            });
            log.debug("downstream call ok", kv("dependency", name), kv("operation", operation), kv("ms", elapsedMs(started)));
            return result;
        } catch (CallNotPermittedException e) {
            throw new Unavailable(name, name + " " + operation + ": circuit breaker is " + breaker.getState(), e);
        } catch (Unavailable | Rejected e) {
            log.warn("downstream call failed", kv("dependency", name), kv("operation", operation), kv("ms", elapsedMs(started)),
                    kv("kind", e.getClass().getSimpleName()), kv("error", e.getMessage()), kv("breaker", breaker.getState()));
            throw e;
        }
    }

    /** Correlation header for every outbound request. */
    protected static String requestId() {
        return Correlation.current();
    }

    private RuntimeException translate(String operation, RestClientResponseException e) {
        int status = e.getStatusCode().value();
        String code = null, message = null;
        JsonNode details = null;
        try {
            JsonNode body = objectMapper.readTree(e.getResponseBodyAsString());
            code = body.path("error").asText(null);
            message = body.path("message").asText(null);
            details = body.has("details") ? body.get("details") : null;
        } catch (Exception ignored) {
            // not our error shape
        }
        if (status >= 500) {
            return new Unavailable(name, name + " " + operation + ": HTTP " + status + (code != null ? " " + code : ""), e);
        }
        return new Rejected(name, status, code != null ? code : "http_" + status,
                message != null ? message : name + " answered HTTP " + status, details);
    }

    public CircuitBreaker.State breakerState() {
        return breaker.getState();
    }

    public CircuitBreaker.Metrics breakerMetrics() {
        return breaker.getMetrics();
    }

    public String name() {
        return name;
    }

    private static long elapsedMs(long startedNanos) {
        return (System.nanoTime() - startedNanos) / 1_000_000;
    }

    static String rootMessage(Throwable t) {
        Throwable r = t;
        while (r.getCause() != null && r.getCause() != r) {
            r = r.getCause();
        }
        return r.getClass().getSimpleName() + (r.getMessage() != null ? ": " + r.getMessage() : "");
    }
}
