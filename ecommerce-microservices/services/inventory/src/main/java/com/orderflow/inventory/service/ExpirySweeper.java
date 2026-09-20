package com.orderflow.inventory.service;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import com.orderflow.inventory.config.InventoryProperties;
import com.orderflow.inventory.correlation.Correlation;
import com.orderflow.inventory.domain.Reservation;
import com.orderflow.inventory.domain.ReservationRepository;
import com.orderflow.inventory.domain.ReservationStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * THE EXPIRY SWEEPER — the compensating action on a timer.
 *
 * <p>A hold that is never confirmed or cancelled (the customer closed the tab
 * during the OTP screen) would otherwise keep its units in {@code reserved}
 * forever. Every {@code INVENTORY_SWEEPER_INTERVAL_MS} this job finds HELD
 * reservations whose {@code expires_at} has passed and releases them:
 * reserved → available, status → EXPIRED, one {@code InventoryReleased}
 * event (reason EXPIRED) per hold.
 *
 * <p><b>Safe under overlap and across instances.</b>
 * <ul>
 *   <li>Candidates are fetched in batches WITHOUT locks (a cheap partial-index
 *       scan), then each is handled in its OWN short transaction.</li>
 *   <li>Inside that transaction the row is re-selected with
 *       {@code FOR UPDATE SKIP LOCKED} and the predicates
 *       {@code status = 'HELD' AND expires_at <= now} are re-evaluated under
 *       the lock. A second sweeper (another instance, or a slow previous run)
 *       skips rows the first one is holding; a hold that got confirmed or
 *       released in the meantime no longer matches and is left alone. A
 *       reservation therefore cannot be released twice — and the CHECK
 *       constraint on {@code reserved >= 0} would refuse it anyway.</li>
 *   <li>One transaction per reservation keeps every transaction's inventory
 *       locks in a single ascending run (see {@link LockOrder}); locking
 *       several holds' products in one transaction would break that order.</li>
 *   <li>{@code fixedDelay} scheduling means a run never overlaps itself in one
 *       JVM; the locking above covers everything else.</li>
 * </ul>
 */
@Component
@ConditionalOnProperty(name = "inventory.sweeper.enabled", havingValue = "true", matchIfMissing = true)
public class ExpirySweeper {

    private static final Logger log = LoggerFactory.getLogger(ExpirySweeper.class);
    /** Upper bound on batches per run so a huge backlog is drained across runs, not in one. */
    private static final int MAX_BATCHES_PER_RUN = 20;

    private final ReservationRepository reservationRepository;
    private final InventoryService inventoryService;
    private final InventoryEventPublisher publisher;
    private final InventoryProperties properties;
    private final TransactionTemplate tx;
    private final Clock clock;

    private final AtomicReference<Instant> lastRunAt = new AtomicReference<>();
    private final AtomicLong lastRunReleased = new AtomicLong();
    private final AtomicLong totalReleased = new AtomicLong();

    public ExpirySweeper(ReservationRepository reservationRepository,
                         InventoryService inventoryService,
                         InventoryEventPublisher publisher,
                         InventoryProperties properties,
                         PlatformTransactionManager transactionManager,
                         Clock clock) {
        this.reservationRepository = reservationRepository;
        this.inventoryService = inventoryService;
        this.publisher = publisher;
        this.properties = properties;
        this.tx = new TransactionTemplate(transactionManager);
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${inventory.sweeper.interval-ms}", initialDelayString = "${inventory.sweeper.interval-ms}")
    public void run() {
        String runId = Correlation.newId("sweep");
        Correlation.set(runId);
        try {
            int released = sweep();
            lastRunAt.set(clock.instant());
            lastRunReleased.set(released);
            totalReleased.addAndGet(released);
            if (released > 0) {
                log.info("sweep finished", kv("expiredHolds", released));
            } else {
                log.debug("sweep finished — no expired holds");
            }
        } catch (RuntimeException e) {
            // Never let one bad run kill the schedule; the next run retries.
            log.error("sweep failed — will retry on the next interval", e);
        } finally {
            Correlation.clear();
        }
    }

    /** Package-private so tests / manual triggers can call it. Returns the number of holds released. */
    int sweep() {
        int batchSize = properties.sweeper().batchSize();
        int released = 0;
        for (int batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
            Instant now = clock.instant();
            List<UUID> candidates = reservationRepository.findExpiredHeldIds(now, batchSize);
            if (candidates.isEmpty()) {
                break;
            }
            for (UUID id : candidates) {
                if (expireOne(id, now)) {
                    released++;
                }
            }
            if (candidates.size() < batchSize) {
                break;
            }
        }
        return released;
    }

    /** One reservation, one transaction. Returns true if THIS call released it. */
    private boolean expireOne(UUID id, Instant now) {
        Optional<ReservationView> expired = tx.execute(status -> {
            Optional<Reservation> locked = reservationRepository.lockExpiredHeld(id, now);
            if (locked.isEmpty()) {
                // Already handled by someone else (confirmed, released, or another sweeper holds it).
                return Optional.<ReservationView>empty();
            }
            Reservation reservation = locked.get();
            inventoryService.releaseHeldInTransaction(reservation, ReservationStatus.EXPIRED);
            return Optional.of(ReservationView.of(reservation));
        });

        if (expired.isEmpty()) {
            log.debug("expiry candidate skipped — no longer HELD or locked elsewhere", kv("reservationId", id));
            return false;
        }
        ReservationView r = expired.get();
        log.warn("HOLD EXPIRED — released back to available", kv("orderId", r.orderId()), kv("reservationId", r.id()),
                kv("expiredAt", r.expiresAt()), kv("items", r.items()), kv("totalQuantity", r.totalQuantity()),
                kv("overdueMs", now.toEpochMilli() - r.expiresAt().toEpochMilli()));
        publisher.publish(InventoryEvent.released(r, InventoryEvent.ReleaseReason.EXPIRED, Correlation.current()));
        return true;
    }

    public Instant lastRunAt() {
        return lastRunAt.get();
    }

    public long lastRunReleased() {
        return lastRunReleased.get();
    }

    public long totalReleased() {
        return totalReleased.get();
    }
}
