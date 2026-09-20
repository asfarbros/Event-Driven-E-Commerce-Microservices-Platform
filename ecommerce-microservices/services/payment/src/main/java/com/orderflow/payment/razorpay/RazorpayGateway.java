package com.orderflow.payment.razorpay;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import com.fasterxml.jackson.databind.JsonNode;
import com.orderflow.payment.config.PaymentProperties;
import com.orderflow.payment.razorpay.RazorpayExceptions.Rejected;
import com.orderflow.payment.razorpay.RazorpayExceptions.Unavailable;
import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * The ONLY place in OrderFlow that talks to Razorpay (the external gateway).
 *
 * <p>Transport: Spring {@link RestClient} over the JDK HttpClient, Basic auth
 * {@code key_id:key_secret}, connect + read timeout {@code RAZORPAY_TIMEOUT_MS},
 * base URL {@code RAZORPAY_API_BASE_URL} (https://api.razorpay.com/v1 for real
 * use; anything else for fault injection).
 *
 * <p>Every call runs inside a Resilience4j {@link CircuitBreaker} configured
 * from {@code PAYMENT_BREAKER_*}: after enough timeouts / 5xx the breaker OPENS
 * and calls fail immediately with {@link Unavailable} (no waiting on a dead
 * dependency); after {@code waitInOpenMs} it goes HALF-OPEN and lets a few
 * trial calls through; successes CLOSE it. 4xx answers ({@link Rejected}) are
 * NOT failures for the breaker — Razorpay is up, our request was wrong.
 * State transitions are logged at WARN.
 *
 * <p>MONEY: every {@code amount} here is an integer in the smallest currency
 * unit (paise), exactly as stored in payment_transaction. Razorpay's API uses
 * the same unit, so the number is passed through UNCHANGED.
 *
 * <p>Logging rules: the Authorization header, request bodies and response
 * bodies are never logged. Only ids, amounts, statuses and Razorpay error
 * codes/descriptions are.
 */
@Component
public class RazorpayGateway {

    private static final Logger log = LoggerFactory.getLogger(RazorpayGateway.class);

    private final RestClient client;
    private final CircuitBreaker breaker;
    private final String keyId;

    public RazorpayGateway(PaymentProperties properties) {
        PaymentProperties.Razorpay rzp = properties.razorpay();
        this.keyId = rzp.keyId();

        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(
                HttpClient.newBuilder().connectTimeout(rzp.timeout()).build());
        factory.setReadTimeout(rzp.timeout());
        this.client = RestClient.builder()
                .baseUrl(rzp.baseUrl().replaceAll("/+$", ""))
                .requestFactory(factory)
                .defaultHeaders(h -> {
                    h.setBasicAuth(rzp.keyId(), rzp.keySecret());
                    h.setContentType(MediaType.APPLICATION_JSON);
                    h.setAccept(List.of(MediaType.APPLICATION_JSON));
                })
                .build();

        PaymentProperties.Breaker b = properties.breaker();
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
        this.breaker = CircuitBreaker.of("razorpay", config);
        this.breaker.getEventPublisher()
                .onStateTransition(e -> log.warn("razorpay circuit breaker state changed",
                        kv("from", e.getStateTransition().getFromState()), kv("to", e.getStateTransition().getToState()),
                        kv("failureRate", breaker.getMetrics().getFailureRate()),
                        kv("bufferedCalls", breaker.getMetrics().getNumberOfBufferedCalls())))
                .onCallNotPermitted(e -> log.warn("razorpay call rejected — circuit breaker is OPEN",
                        kv("state", breaker.getState())));
    }

    // ---- API surface ----------------------------------------------------------

    public record Order(String id, long amount, String currency, String receipt, String status) {
    }

    public record Payment(String id, String orderId, long amount, String currency, String status, String method,
                          String errorCode, String errorDescription, String errorReason) {
        public boolean isCaptured() {
            return "captured".equals(status);
        }

        public boolean isFailed() {
            return "failed".equals(status);
        }
    }

    public record Refund(String id, String paymentId, long amount, String currency, String status) {
        public boolean isProcessed() {
            return "processed".equals(status);
        }

        public boolean isFailed() {
            return "failed".equals(status);
        }
    }

    /** POST /orders — creates the Razorpay order the browser widget will open. {@code receipt} = our orderId. */
    public Order createOrder(long amountInPaise, String currency, String receipt, Map<String, String> notes) {
        Map<String, Object> body = Map.of("amount", amountInPaise, "currency", currency, "receipt", receipt, "notes", notes);
        JsonNode json = call("createOrder", () -> client.post().uri("/orders").body(body).retrieve().body(JsonNode.class));
        return toOrder(json);
    }

    /** GET /orders?receipt= — finds an order we created earlier but never learnt the id of (lost response). */
    public List<Order> findOrdersByReceipt(String receipt) {
        JsonNode json = call("findOrdersByReceipt", () -> client.get()
                .uri(b -> b.path("/orders").queryParam("receipt", receipt).queryParam("count", 10).build())
                .retrieve().body(JsonNode.class));
        List<Order> orders = new ArrayList<>();
        for (JsonNode item : json.path("items")) {
            orders.add(toOrder(item));
        }
        return orders;
    }

    /** GET /orders/{id}/payments — every attempt the user made inside that checkout. */
    public List<Payment> listOrderPayments(String razorpayOrderId) {
        JsonNode json = call("listOrderPayments", () -> client.get().uri("/orders/{id}/payments", razorpayOrderId)
                .retrieve().body(JsonNode.class));
        List<Payment> payments = new ArrayList<>();
        for (JsonNode item : json.path("items")) {
            payments.add(toPayment(item));
        }
        return payments;
    }

    /** POST /payments/{id}/refund — full refund. {@code receipt} = our refund id (Razorpay's own idempotency hint). */
    public Refund refundPayment(String razorpayPaymentId, long amountInPaise, String receipt, Map<String, String> notes) {
        Map<String, Object> body = Map.of("amount", amountInPaise, "receipt", receipt, "notes", notes);
        JsonNode json = call("refundPayment", () -> client.post().uri("/payments/{id}/refund", razorpayPaymentId)
                .body(body).retrieve().body(JsonNode.class));
        return toRefund(json);
    }

    /** GET /payments/{id}/refunds — used before retrying a refund whose response we may have lost. */
    public List<Refund> listPaymentRefunds(String razorpayPaymentId) {
        JsonNode json = call("listPaymentRefunds", () -> client.get().uri("/payments/{id}/refunds", razorpayPaymentId)
                .retrieve().body(JsonNode.class));
        List<Refund> refunds = new ArrayList<>();
        for (JsonNode item : json.path("items")) {
            refunds.add(toRefund(item));
        }
        return refunds;
    }

    /** GET /refunds/{id} */
    public Refund fetchRefund(String razorpayRefundId) {
        return toRefund(call("fetchRefund", () -> client.get().uri("/refunds/{id}", razorpayRefundId)
                .retrieve().body(JsonNode.class)));
    }

    public CircuitBreaker.State breakerState() {
        return breaker.getState();
    }

    public CircuitBreaker.Metrics breakerMetrics() {
        return breaker.getMetrics();
    }

    public String keyId() {
        return keyId;
    }

    // ---- plumbing -------------------------------------------------------------

    private JsonNode call(String operation, Supplier<JsonNode> request) {
        long started = System.nanoTime();
        try {
            JsonNode result = breaker.executeSupplier(() -> {
                try {
                    JsonNode json = request.get();
                    if (json == null) {
                        throw new Unavailable("razorpay " + operation + ": empty response");
                    }
                    return json;
                } catch (RestClientResponseException e) {
                    throw translate(operation, e);
                } catch (ResourceAccessException e) {
                    // connect/read timeout, connection refused, DNS failure
                    throw new Unavailable("razorpay " + operation + ": " + rootMessage(e), e);
                }
            });
            log.debug("razorpay call ok", kv("operation", operation), kv("ms", elapsedMs(started)));
            return result;
        } catch (CallNotPermittedException e) {
            throw new Unavailable("razorpay " + operation + ": circuit breaker is " + breaker.getState());
        } catch (Unavailable | Rejected e) {
            log.warn("razorpay call failed", kv("operation", operation), kv("ms", elapsedMs(started)),
                    kv("kind", e.getClass().getSimpleName()), kv("error", e.getMessage()), kv("breaker", breaker.getState()));
            throw e;
        }
    }

    private static RuntimeException translate(String operation, RestClientResponseException e) {
        int status = e.getStatusCode().value();
        String code = null, description = null;
        try {
            JsonNode err = new com.fasterxml.jackson.databind.ObjectMapper().readTree(e.getResponseBodyAsString()).path("error");
            code = err.path("code").asText(null);
            description = err.path("description").asText(null);
        } catch (Exception ignored) {
            // body was not Razorpay's error JSON
        }
        if (status >= 500) {
            return new Unavailable("razorpay " + operation + ": HTTP " + status + (description != null ? " " + description : ""), e);
        }
        return new Rejected(status, code, description != null ? description : "HTTP " + status + " from Razorpay");
    }

    private static Order toOrder(JsonNode n) {
        return new Order(n.path("id").asText(null), n.path("amount").asLong(), n.path("currency").asText(null),
                n.path("receipt").asText(null), n.path("status").asText(null));
    }

    private static Payment toPayment(JsonNode n) {
        return new Payment(n.path("id").asText(null), n.path("order_id").asText(null), n.path("amount").asLong(),
                n.path("currency").asText(null), n.path("status").asText(null), n.path("method").asText(null),
                n.path("error_code").asText(null), n.path("error_description").asText(null), n.path("error_reason").asText(null));
    }

    private static Refund toRefund(JsonNode n) {
        return new Refund(n.path("id").asText(null), n.path("payment_id").asText(null), n.path("amount").asLong(),
                n.path("currency").asText(null), n.path("status").asText(null));
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
