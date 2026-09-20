package com.orderflow.inventory.service;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.orderflow.inventory.domain.InventoryRepository;
import com.orderflow.inventory.domain.ReservationRepository;
import com.orderflow.inventory.domain.ReservationStatus;
import com.orderflow.inventory.service.InventoryService.AdjustOperation;
import com.orderflow.inventory.service.InventoryService.Line;
import com.orderflow.inventory.service.ServiceExceptions.InsufficientStockException;
import org.junit.jupiter.api.AfterEach;
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
 * THE CONCURRENCY PROOF, in-process: many threads hit {@link InventoryService}
 * at once against the real inventory_db (needs PostgreSQL up and the root
 * .env). Kafka is not needed — the publisher is replaced with an in-memory one
 * and the consumer/sweeper are off.
 *
 * Opt-in (it needs infrastructure):  ./mvnw test -Pit
 *
 * Test rows use the prefix {@code it-} and are deleted afterwards; seeded
 * catalogue rows are never touched.
 */
@Tag("integration")
@SpringBootTest(properties = {
        "inventory.kafka.consumer-enabled=false",
        "inventory.sweeper.enabled=false",
        "spring.kafka.bootstrap-servers=localhost:1",   // never contacted: publisher is stubbed, consumer off
        "spring.kafka.admin.fail-fast=false"
})
class ReserveConcurrencyIT {

    @TestConfiguration
    static class StubPublisher {
        @Bean
        @Primary
        InventoryEventPublisher recordingPublisher() {
            return event -> published.incrementAndGet();
        }
    }

    static final AtomicInteger published = new AtomicInteger();

    @Autowired InventoryService service;
    @Autowired InventoryRepository inventoryRepository;
    @Autowired ReservationRepository reservationRepository;
    @Autowired JdbcTemplate jdbc;

    private final String tag = UUID.randomUUID().toString().substring(0, 8);

    @AfterEach
    void cleanUp() {
        jdbc.update("delete from reservation_item where product_id like 'it-%'");
        jdbc.update("delete from reservation where order_id like 'it-%'");
        jdbc.update("delete from inventory where product_id like 'it-%'");
    }

    @Test
    void fiftyThreadsFightForOneUnit_exactlyOneWins() throws Exception {
        String productId = "it-single-" + tag;
        service.adjust(productId, AdjustOperation.SET, 1);

        Outcome outcome = fire(50, i -> service.reserve("it-ord-" + tag + "-" + i, List.of(new Line(productId, 1))));

        assertThat(outcome.created).isEqualTo(1);
        assertThat(outcome.insufficient).isEqualTo(49);
        assertThat(outcome.otherErrors).isEmpty();
        var row = inventoryRepository.findById(productId).orElseThrow();
        assertThat(row.getAvailable()).isZero();
        assertThat(row.getReserved()).isEqualTo(1);
        assertThat(reservationRepository.findAll().stream()
                .filter(r -> r.getOrderId().startsWith("it-ord-" + tag) && r.getStatus() == ReservationStatus.HELD))
                .hasSize(1);
    }

    @Test
    void fiftyThreadsForFiveUnits_exactlyFiveWin() throws Exception {
        String productId = "it-five-" + tag;
        service.adjust(productId, AdjustOperation.SET, 5);

        Outcome outcome = fire(50, i -> service.reserve("it-ord5-" + tag + "-" + i, List.of(new Line(productId, 1))));

        assertThat(outcome.created).isEqualTo(5);
        assertThat(outcome.insufficient).isEqualTo(45);
        assertThat(outcome.otherErrors).isEmpty();
        var row = inventoryRepository.findById(productId).orElseThrow();
        assertThat(row.getAvailable()).isZero();
        assertThat(row.getReserved()).isEqualTo(5);
    }

    @Test
    void oppositeOrderMultiItemReserves_neverDeadlock() throws Exception {
        String a = "it-dl-a-" + tag;
        String b = "it-dl-b-" + tag;
        service.adjust(a, AdjustOperation.SET, 500);
        service.adjust(b, AdjustOperation.SET, 500);

        Outcome outcome = fire(40, i -> service.reserve("it-dl-" + tag + "-" + i, i % 2 == 0
                ? List.of(new Line(a, 1), new Line(b, 1))
                : List.of(new Line(b, 1), new Line(a, 1))));

        assertThat(outcome.otherErrors).as("no deadlock / lock timeout").isEmpty();
        assertThat(outcome.created).isEqualTo(40);
        assertThat(inventoryRepository.findById(a).orElseThrow().getReserved()).isEqualTo(40);
        assertThat(inventoryRepository.findById(b).orElseThrow().getReserved()).isEqualTo(40);
    }

    @Test
    void concurrentRetriesOfTheSameOrder_reserveOnce() throws Exception {
        String productId = "it-idem-" + tag;
        String orderId = "it-idem-ord-" + tag;
        service.adjust(productId, AdjustOperation.SET, 100);

        Outcome outcome = fire(30, i -> service.reserve(orderId, List.of(new Line(productId, 2))));

        assertThat(outcome.created).isEqualTo(1);
        assertThat(outcome.replayed).isEqualTo(29);
        assertThat(outcome.otherErrors).isEmpty();
        var row = inventoryRepository.findById(productId).orElseThrow();
        assertThat(row.getAvailable()).isEqualTo(98);
        assertThat(row.getReserved()).isEqualTo(2);
    }

    // -------------------------------------------------------------------------

    record Outcome(int created, int replayed, int insufficient, List<String> otherErrors) {
    }

    interface Call {
        InventoryService.ReserveResult run(int i);
    }

    /** Starts N threads, releases them all at the same instant, and tallies the results. */
    private static Outcome fire(int n, Call call) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<String>> futures = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            final int idx = i;
            futures.add(pool.submit(() -> {
                go.await();
                try {
                    return call.run(idx).created() ? "created" : "replayed";
                } catch (InsufficientStockException e) {
                    return "insufficient";
                } catch (RuntimeException e) {
                    return "error:" + e.getClass().getSimpleName();
                }
            }));
        }
        go.countDown();
        int created = 0, replayed = 0, insufficient = 0;
        List<String> errors = new ArrayList<>();
        for (Future<String> f : futures) {
            String r = f.get(60, TimeUnit.SECONDS);
            switch (r) {
                case "created" -> created++;
                case "replayed" -> replayed++;
                case "insufficient" -> insufficient++;
                default -> errors.add(r);
            }
        }
        pool.shutdownNow();
        return new Outcome(created, replayed, insufficient, errors);
    }
}
