package com.orderflow.payment.service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.orderflow.payment.config.PaymentProperties;
import com.orderflow.payment.domain.PaymentStatus;
import com.orderflow.payment.domain.PaymentTransactionRepository;
import com.orderflow.payment.domain.WebhookEventRepository;
import com.orderflow.payment.razorpay.RazorpayGateway;
import com.orderflow.payment.razorpay.WebhookSignature;
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
 * THE MONEY-SAFETY PROOF, in-process against the real payment_db (needs
 * PostgreSQL and the root .env). Razorpay is replaced by an in-memory fake that
 * counts every order and refund it is asked for; Kafka is not needed (publisher
 * stubbed, consumer/reconciliation off).
 *
 * Opt-in:  ./mvnw test -Pit
 *
 * Test rows use the prefix {@code it-} and are deleted afterwards.
 */
@Tag("integration")
@SpringBootTest(properties = {
        "payment.kafka.consumer-enabled=false",
        "payment.reconciliation.enabled=false",
        "spring.kafka.bootstrap-servers=localhost:1",
        "spring.kafka.admin.fail-fast=false"
})
class IdempotencyIT {

    /** Counts what the "gateway" was asked to do, so double orders / double refunds are visible. */
    static final AtomicInteger ordersCreated = new AtomicInteger();
    static final AtomicInteger refundsCreated = new AtomicInteger();
    static final AtomicInteger eventsPublished = new AtomicInteger();

    @TestConfiguration
    static class Fakes {
        @Bean
        @Primary
        RazorpayGateway fakeGateway(PaymentProperties properties) {
            return new RazorpayGateway(properties) {
                @Override
                public Order createOrder(long amountInPaise, String currency, String receipt, Map<String, String> notes) {
                    ordersCreated.incrementAndGet();
                    return new Order("order_fake_" + UUID.randomUUID().toString().substring(0, 8), amountInPaise, currency, receipt, "created");
                }

                @Override
                public List<Refund> listPaymentRefunds(String razorpayPaymentId) {
                    return List.of();
                }

                @Override
                public Refund refundPayment(String razorpayPaymentId, long amountInPaise, String receipt, Map<String, String> notes) {
                    refundsCreated.incrementAndGet();
                    return new Refund("rfnd_fake_" + UUID.randomUUID().toString().substring(0, 8), razorpayPaymentId, amountInPaise, "INR", "processed");
                }
            };
        }

        @Bean
        @Primary
        PaymentEventPublisher countingPublisher() {
            return event -> eventsPublished.incrementAndGet();
        }
    }

    @Autowired PaymentService paymentService;
    @Autowired WebhookService webhookService;
    @Autowired PaymentTransactionRepository transactions;
    @Autowired WebhookEventRepository webhooks;
    @Autowired PaymentProperties properties;
    @Autowired JdbcTemplate jdbc;

    private final String tag = UUID.randomUUID().toString().substring(0, 8);

    @BeforeEach
    void reset() {
        ordersCreated.set(0);
        refundsCreated.set(0);
        eventsPublished.set(0);
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("delete from payment_refund where payment_id in (select id from payment_transaction where order_id like 'it-%')");
        jdbc.update("delete from webhook_event where provider_event_id like 'it-%'");
        jdbc.update("delete from payment_transaction where order_id like 'it-%'");
    }

    @Test
    void thirtyConcurrentCreatesForOneOrder_oneRowOneGatewayOrder() throws Exception {
        String orderId = "it-create-" + tag;
        List<String> results = fire(30, i -> {
            PaymentService.CreateResult r = paymentService.create(orderId, "user_it", 50000L, "INR");
            return (r.created() ? "created:" : "replayed:") + r.payment().razorpayOrderId();
        });
        assertThat(results.stream().filter(r -> r.startsWith("created:")).count()).isEqualTo(1);
        assertThat(results.stream().map(r -> r.substring(r.indexOf(':') + 1)).distinct()).hasSize(1);
        assertThat(ordersCreated.get()).as("gateway orders created").isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from payment_transaction where order_id = ?", Integer.class, orderId)).isEqualTo(1);
    }

    @Test
    void thirtyConcurrentDeliveriesOfOneWebhook_appliedOnceOneEvent() throws Exception {
        String orderId = "it-webhook-" + tag;
        PaymentService.CreateResult created = paymentService.create(orderId, "user_it", 50000L, "INR");
        String rzpOrder = created.payment().razorpayOrderId();
        String body = "{\"event\":\"payment.captured\",\"payload\":{\"payment\":{\"entity\":{\"id\":\"pay_it_" + tag
                + "\",\"amount\":50000,\"currency\":\"INR\",\"status\":\"captured\",\"order_id\":\"" + rzpOrder + "\"}}}}";
        String signature = WebhookSignature.sign(body, properties.razorpay().webhookSecret());
        String eventId = "it-evt-" + tag;

        List<String> results = fire(30, i -> webhookService.process(body, signature, eventId).outcome().name());

        assertThat(results.stream().filter("PROCESSED"::equals).count()).isEqualTo(1);
        assertThat(results.stream().filter("DUPLICATE"::equals).count()).isEqualTo(29);
        assertThat(webhooks.countByProviderAndProviderEventId("razorpay", eventId)).isEqualTo(1);
        assertThat(transactions.findByOrderId(orderId).orElseThrow().getStatus()).isEqualTo(PaymentStatus.SUCCESS);
        assertThat(eventsPublished.get()).as("PaymentSucceeded published exactly once").isEqualTo(1);
    }

    @Test
    void thirtyConcurrentCancellations_refundOnce() throws Exception {
        String orderId = "it-refund-" + tag;
        PaymentService.CreateResult created = paymentService.create(orderId, "user_it", 50000L, "INR");
        String body = "{\"event\":\"payment.captured\",\"payload\":{\"payment\":{\"entity\":{\"id\":\"pay_it2_" + tag
                + "\",\"amount\":50000,\"currency\":\"INR\",\"status\":\"captured\",\"order_id\":\"" + created.payment().razorpayOrderId() + "\"}}}}";
        webhookService.process(body, WebhookSignature.sign(body, properties.razorpay().webhookSecret()), "it-evt2-" + tag);
        eventsPublished.set(0);

        List<String> results = fire(30, i -> paymentService.refund(orderId, "order_cancelled", "it-cancel-" + i, false).outcome().name());

        assertThat(refundsCreated.get()).as("gateway refunds created").isEqualTo(1);
        assertThat(results).contains("REFUNDED");
        assertThat(results.stream().filter(r -> r.equals("REFUNDED") || r.equals("ALREADY_REFUNDED") || r.equals("REFUND_PENDING")).count()).isEqualTo(30);
        assertThat(jdbc.queryForObject("select count(*) from payment_refund r join payment_transaction t on t.id = r.payment_id where t.order_id = ?", Integer.class, orderId)).isEqualTo(1);
        assertThat(transactions.findByOrderId(orderId).orElseThrow().getStatus()).isEqualTo(PaymentStatus.REFUNDED);
        assertThat(eventsPublished.get()).as("PaymentRefunded published exactly once").isEqualTo(1);
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
