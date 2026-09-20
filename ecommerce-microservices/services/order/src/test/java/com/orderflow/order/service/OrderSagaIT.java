package com.orderflow.order.service;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.order.clients.Clients;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.domain.OrderRepository;
import com.orderflow.order.domain.OrderStatus;
import com.orderflow.order.domain.OutboxRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * THE SAGA-SAFETY PROOF, in-process against the real order_db. The four
 * downstream services are replaced by fakes that count what they were asked
 * to do; Kafka and RabbitMQ are not needed (consumer off, relay interval huge,
 * brokers pointed at a closed port).
 *
 * Opt-in:  ./mvnw test -Pit
 */
@Tag("integration")
@SpringBootTest(properties = {
        "order.kafka.consumer-enabled=false",
        "order.reconciliation.enabled=false",
        "order.outbox.enabled=false",
        "order.outbox.relay-interval-ms=600000",
        "spring.kafka.bootstrap-servers=localhost:1",
        "spring.kafka.admin.fail-fast=false",
        "spring.rabbitmq.addresses=amqp://guest:guest@localhost:1"
})
class OrderSagaIT {

    static final AtomicInteger reserves = new AtomicInteger();
    static final AtomicInteger payments = new AtomicInteger();
    static final AtomicInteger releases = new AtomicInteger();

    @TestConfiguration
    static class Fakes {
        @Bean @Primary
        Clients.Cart cart(OrderProperties p, ObjectMapper om) {
            return new Clients.Cart(p, om) {
                @Override public Snapshot snapshot(String userId) {
                    return new Snapshot(userId, List.of(new Line("prod-A", "SKU-A", "Thing A", 2, 12500L, 25000L, "INR")), 1, 2, "INR", 25000L, null, null);
                }
                @Override public void clear(String userId) { }
            };
        }

        @Bean @Primary
        Clients.Catalog catalog(OrderProperties p, ObjectMapper om) {
            return new Clients.Catalog(p, om) {
                @Override public Prices prices(List<String> ids) {
                    return new Prices(List.of(new Price("prod-A", "SKU-A", "Thing A", 12500L, "INR")), List.of(), null);
                }
            };
        }

        @Bean @Primary
        Clients.Inventory inventory(OrderProperties p, ObjectMapper om) {
            return new Clients.Inventory(p, om) {
                @Override public Reservation reserve(String orderId, List<ReserveLine> lines) {
                    reserves.incrementAndGet();
                    return new Reservation("res-" + orderId.substring(0, 8), orderId, "HELD", true, "2026-09-20T10:10:00Z");
                }
                @Override public void release(String orderId) { releases.incrementAndGet(); }
            };
        }

        @Bean @Primary
        Clients.Payment payment(OrderProperties p, ObjectMapper om) {
            return new Clients.Payment(p, om) {
                @Override public Created create(String orderId, String userId, long amount, String currency) {
                    payments.incrementAndGet();
                    return new Created("pay-" + orderId.substring(0, 8), orderId, "PENDING", true, "order_fake", "rzp_test_x", amount, currency);
                }
                @Override public Status status(String orderId) { return null; }
            };
        }
    }

    @Autowired CheckoutService checkout;
    @Autowired OrderService orders;
    @Autowired OrderRepository orderRepository;
    @Autowired OutboxRepository outbox;
    @Autowired JdbcTemplate jdbc;

    private final String user = "it-user-" + UUID.randomUUID().toString().substring(0, 8);

    @BeforeEach
    void reset() {
        reserves.set(0);
        payments.set(0);
        releases.set(0);
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("delete from outbox_event where order_id in (select id::text from orders where user_id like 'it-user-%')");
        jdbc.update("delete from processed_event where event_id like 'it-%'");
        jdbc.update("delete from orders where user_id like 'it-user-%'");
    }

    @Test
    void thirtyConcurrentCheckoutsWithOneIdempotencyKey_oneOrderOneReserveOnePayment() throws Exception {
        List<String> results = fire(30, i -> {
            CheckoutService.CheckoutResult r = checkout.checkout(user, "it-key-1", "");
            return (r.created() ? "created:" : "replayed:") + r.order().orderId();
        });
        assertThat(results.stream().filter(r -> r.startsWith("created:")).count()).isEqualTo(1);
        assertThat(results.stream().map(r -> r.substring(r.indexOf(':') + 1)).distinct()).hasSize(1);
        assertThat(reserves.get()).as("inventory reserve calls").isEqualTo(1);
        assertThat(payments.get()).as("payment create calls").isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from orders where user_id = ?", Integer.class, user)).isEqualTo(1);
    }

    @Test
    void thirtyConcurrentDeliveriesOfPaymentSucceeded_appliedOnceWithOneConfirmedEventAndOneNotification() throws Exception {
        UUID orderId = checkout.checkout(user, "it-key-2", "").order().orderId();
        assertThat(orderRepository.findById(orderId).orElseThrow().getStatus()).isEqualTo(OrderStatus.AWAITING_PAYMENT);
        String eventId = "it-evt-" + orderId;

        List<String> results = fire(30, i -> orders.applyEvent("payment-events", eventId, "PaymentSucceeded", orderId.toString(), null).name());

        assertThat(results.stream().filter("APPLIED"::equals).count()).isEqualTo(1);
        assertThat(results.stream().filter("DUPLICATE"::equals).count()).isEqualTo(29);
        assertThat(orderRepository.findById(orderId).orElseThrow().getStatus()).isEqualTo(OrderStatus.CONFIRMED);
        List<String> types = outbox.findByOrderIdOrderByCreatedAt(orderId.toString()).stream().map(e -> e.getEventType()).toList();
        assertThat(types).containsExactly("OrderCreated", "OrderConfirmed", "SendOrderConfirmation");
    }

    @Test
    void staleEventsNeverOverwriteATerminalState() {
        UUID orderId = checkout.checkout(user, "it-key-3", "").order().orderId();
        orders.applyEvent("payment-events", "it-evt-fail-" + orderId, "PaymentFailed", orderId.toString(), "declined");
        assertThat(orderRepository.findById(orderId).orElseThrow().getStatus()).isEqualTo(OrderStatus.FAILED);

        OrderService.Outcome late = orders.applyEvent("payment-events", "it-evt-late-" + orderId, "PaymentSucceeded", orderId.toString(), null);
        // A payment landing on a FAILED order is not applied as CONFIRMED: the order stays FAILED and a refund is requested.
        assertThat(late).isEqualTo(OrderService.Outcome.APPLIED);
        assertThat(orderRepository.findById(orderId).orElseThrow().getStatus()).isEqualTo(OrderStatus.FAILED);
        assertThat(orderRepository.findById(orderId).orElseThrow().getPaymentStatus()).isEqualTo(com.orderflow.order.domain.Order.PaymentState.REFUND_PENDING);
        assertThat(outbox.findByOrderIdOrderByCreatedAt(orderId.toString()).stream().filter(e -> e.getEventType().equals("OrderCancelled")).count()).isEqualTo(2);

        OrderService.Outcome cancelAgain = orders.applyEvent("inventory-events", "it-evt-inv-" + orderId, "InventoryReleased", orderId.toString(), "EXPIRED");
        assertThat(cancelAgain).isEqualTo(OrderService.Outcome.IGNORED_STALE);
        assertThat(orderRepository.findById(orderId).orElseThrow().getStatus()).isEqualTo(OrderStatus.FAILED);
    }

    // -------------------------------------------------------------------------

    interface Call {
        String run(int i) throws Exception;
    }

    private static List<String> fire(int n, Call call) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<String>> futures = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            final int idx = i;
            futures.add(pool.submit(() -> {
                go.await();
                try {
                    return call.run(idx);
                } catch (Exception e) {
                    return "error:" + e.getClass().getSimpleName() + ":" + e.getMessage();
                }
            }));
        }
        go.countDown();
        List<String> results = new ArrayList<>();
        for (Future<String> f : futures) {
            results.add(f.get(60, TimeUnit.SECONDS));
        }
        pool.shutdownNow();
        assertThat(results).noneMatch(r -> r.startsWith("error:"));
        return results;
    }
}
