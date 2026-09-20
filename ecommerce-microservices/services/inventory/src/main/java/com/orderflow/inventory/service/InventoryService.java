package com.orderflow.inventory.service;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;

import com.orderflow.inventory.config.InventoryProperties;
import com.orderflow.inventory.correlation.Correlation;
import com.orderflow.inventory.domain.Inventory;
import com.orderflow.inventory.domain.InventoryRepository;
import com.orderflow.inventory.domain.Reservation;
import com.orderflow.inventory.domain.ReservationRepository;
import com.orderflow.inventory.domain.ReservationStatus;
import com.orderflow.inventory.service.ServiceExceptions.InsufficientStockException;
import com.orderflow.inventory.service.ServiceExceptions.InvalidAdjustmentException;
import com.orderflow.inventory.service.ServiceExceptions.ProductNotFoundException;
import com.orderflow.inventory.service.ServiceExceptions.ReservationNotFoundException;
import com.orderflow.inventory.service.ServiceExceptions.ReservationNotRestockableException;
import com.orderflow.inventory.service.ServiceExceptions.Shortage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * The stock state machine. Every mutation follows the same discipline:
 *
 * <ol>
 *   <li>ONE database transaction wraps the whole read-check-write.</li>
 *   <li>If a reservation header is involved, its row is locked first
 *       ({@code FOR UPDATE}), so two transitions of the same hold serialise.</li>
 *   <li>Inventory rows are then locked one by one in ASCENDING productId order
 *       ({@link LockOrder}) with {@code SELECT ... FOR UPDATE}. The lock is held
 *       until commit/rollback — a few milliseconds — and bounded by
 *       {@code lock_timeout} (INVENTORY_LOCK_TIMEOUT_MS), after which the
 *       waiter fails cleanly instead of queueing behind a stuck transaction.</li>
 *   <li>The Kafka event is published only AFTER the transaction has committed,
 *       so consumers never see an event for state that was rolled back.</li>
 * </ol>
 *
 * Transactions are explicit ({@link TransactionTemplate}) rather than
 * {@code @Transactional} so the commit boundary — and the "publish after
 * commit" rule — is visible in the code rather than hidden in a proxy.
 */
@Service
public class InventoryService {

    private static final Logger log = LoggerFactory.getLogger(InventoryService.class);

    private final InventoryRepository inventoryRepository;
    private final ReservationRepository reservationRepository;
    private final InventoryEventPublisher publisher;
    private final InventoryProperties properties;
    private final TransactionTemplate tx;
    private final TransactionTemplate readOnlyTx;
    private final Clock clock;

    public InventoryService(InventoryRepository inventoryRepository,
                            ReservationRepository reservationRepository,
                            InventoryEventPublisher publisher,
                            InventoryProperties properties,
                            PlatformTransactionManager transactionManager,
                            Clock clock) {
        this.inventoryRepository = inventoryRepository;
        this.reservationRepository = reservationRepository;
        this.publisher = publisher;
        this.properties = properties;
        this.tx = new TransactionTemplate(transactionManager);
        this.readOnlyTx = new TransactionTemplate(transactionManager);
        this.readOnlyTx.setReadOnly(true);
        this.clock = clock;
    }

    // -------------------------------------------------------------------------
    // RESERVE
    // -------------------------------------------------------------------------

    /** A requested line: product + quantity. Duplicates are rejected by the API layer. */
    public record Line(String productId, int quantity) {
    }

    /** Outcome of a reserve call. {@code created} is false on an idempotent replay. */
    public record ReserveResult(ReservationView reservation, boolean created) {
    }

    /**
     * Creates a HOLD for an order: available → reserved for every line, or
     * nothing at all.
     *
     * <p>Idempotent on orderId at three levels:
     * (1) a cheap pre-check returns the existing hold without taking locks;
     * (2) the check is repeated INSIDE the transaction after the row locks are
     * held, which catches a concurrent retry that raced past (1);
     * (3) the UNIQUE(order_id) constraint catches anything else — the loser's
     * transaction rolls back (its decrements vanish) and the winner's hold is
     * returned.
     */
    public ReserveResult reserve(String orderId, List<Line> lines) {
        Optional<ReservationView> existing = readOnlyTx.execute(s -> reservationRepository.findByOrderId(orderId).map(ReservationView::of));
        if (existing.isPresent()) {
            log.info("reserve replayed — returning existing reservation",
                    kv("orderId", orderId), kv("reservationId", existing.get().id()), kv("status", existing.get().status()));
            return new ReserveResult(existing.get(), false);
        }

        List<Line> ordered = LockOrder.sorted(lines, Line::productId);
        String requestId = Correlation.current();

        ReserveResult result;
        try {
            result = tx.execute(status -> reserveInTransaction(orderId, ordered, requestId));
        } catch (DataIntegrityViolationException e) {
            // Level (3): we lost the insert race on UNIQUE(order_id). Our transaction
            // has rolled back, so nothing we decremented survived. Return the winner.
            ReservationView winner = readOnlyTx.execute(s -> reservationRepository.findByOrderId(orderId).map(ReservationView::of))
                    .orElseThrow(() -> e);
            log.info("reserve lost an insert race and replayed the winner", kv("orderId", orderId), kv("reservationId", winner.id()));
            return new ReserveResult(winner, false);
        }

        if (result.created()) {
            ReservationView r = result.reservation();
            log.info("stock reserved (HELD)", kv("orderId", orderId), kv("reservationId", r.id()),
                    kv("items", r.items()), kv("totalQuantity", r.totalQuantity()), kv("expiresAt", r.expiresAt()));
            publisher.publish(InventoryEvent.reserved(r, requestId));
        }
        return result;
    }

    private ReserveResult reserveInTransaction(String orderId, List<Line> ordered, String requestId) {
        Instant now = clock.instant();

        // Lock every product row, in ascending productId order. Rows are not
        // modified yet — first we find out whether the WHOLE order can be met.
        Map<String, Inventory> locked = new LinkedHashMap<>();
        List<Shortage> shortages = new ArrayList<>();
        for (Line line : ordered) {
            Optional<Inventory> row = inventoryRepository.lockByProductId(line.productId());
            if (row.isEmpty()) {
                shortages.add(new Shortage(line.productId(), line.quantity(), 0, line.quantity(), Shortage.UNKNOWN_PRODUCT));
                continue;
            }
            Inventory inventory = row.get();
            if (inventory.getAvailable() < line.quantity()) {
                shortages.add(new Shortage(line.productId(), line.quantity(), inventory.getAvailable(),
                        line.quantity() - inventory.getAvailable(), Shortage.INSUFFICIENT));
            }
            locked.put(line.productId(), inventory);
        }

        // Level (2): now that we hold the locks, a concurrent retry for the same
        // order has either committed (we see it here) or is waiting behind us.
        Optional<Reservation> existing = reservationRepository.findByOrderId(orderId);
        if (existing.isPresent()) {
            return new ReserveResult(ReservationView.of(existing.get()), false);
        }

        // ALL-OR-NOTHING: any shortage fails the whole order. Throwing rolls the
        // transaction back, which releases the locks; no row was changed.
        if (!shortages.isEmpty()) {
            log.warn("reserve rejected — insufficient stock, nothing held", kv("orderId", orderId), kv("shortages", shortages));
            throw new InsufficientStockException(orderId, shortages);
        }

        Reservation reservation = new Reservation(orderId, now.plus(properties.holdDuration()), requestId);
        for (Line line : ordered) {
            locked.get(line.productId()).reserve(line.quantity());
            reservation.addItem(line.productId(), line.quantity());
        }
        reservationRepository.save(reservation);
        return new ReserveResult(ReservationView.of(reservation), true);
    }

    // -------------------------------------------------------------------------
    // CONFIRM (Kafka: OrderConfirmed)
    // -------------------------------------------------------------------------

    public enum ConfirmOutcome { CONFIRMED, ALREADY_CONFIRMED, NOT_HELD }

    public record ConfirmResult(ReservationView reservation, ConfirmOutcome outcome) {
    }

    /**
     * reserved → gone, permanently. Idempotent: a second OrderConfirmed for the
     * same order finds the hold already CONFIRMED and changes nothing. A hold
     * that already expired or was released cannot be confirmed — the units may
     * have been sold to someone else — so it is reported as NOT_HELD and an
     * InventoryConfirmFailed event tells Order Service.
     */
    public ConfirmResult confirm(String orderId) {
        String correlationId = Correlation.current();
        ConfirmResult result = tx.execute(status -> {
            Reservation reservation = reservationRepository.lockByOrderId(orderId)
                    .orElseThrow(() -> new ReservationNotFoundException("orderId " + orderId));
            if (reservation.getStatus() == ReservationStatus.CONFIRMED) {
                return new ConfirmResult(ReservationView.of(reservation), ConfirmOutcome.ALREADY_CONFIRMED);
            }
            if (!reservation.isHeld()) {
                return new ConfirmResult(ReservationView.of(reservation), ConfirmOutcome.NOT_HELD);
            }
            for (var item : LockOrder.sorted(reservation.getItems(), i -> i.getProductId())) {
                Inventory inventory = inventoryRepository.lockByProductId(item.getProductId())
                        .orElseThrow(() -> new IllegalStateException("inventory row vanished for " + item.getProductId()));
                inventory.confirm(item.getQuantity());
            }
            reservation.resolve(ReservationStatus.CONFIRMED, clock.instant());
            return new ConfirmResult(ReservationView.of(reservation), ConfirmOutcome.CONFIRMED);
        });

        ReservationView r = result.reservation();
        switch (result.outcome()) {
            case CONFIRMED -> {
                log.info("hold CONFIRMED — units deducted permanently", kv("orderId", orderId),
                        kv("reservationId", r.id()), kv("items", r.items()), kv("totalQuantity", r.totalQuantity()));
                publisher.publish(InventoryEvent.confirmed(r, correlationId));
            }
            case ALREADY_CONFIRMED -> log.info("OrderConfirmed replayed — hold already CONFIRMED, nothing changed",
                    kv("orderId", orderId), kv("reservationId", r.id()));
            case NOT_HELD -> {
                log.error("OrderConfirmed for a hold that is no longer HELD — stock NOT deducted",
                        kv("orderId", orderId), kv("reservationId", r.id()), kv("status", r.status()));
                publisher.publish(InventoryEvent.confirmFailed(r, correlationId));
            }
        }
        return result;
    }

    // -------------------------------------------------------------------------
    // RELEASE (REST /release, Kafka: OrderCancelled, sweeper)
    // -------------------------------------------------------------------------

    public record ReleaseResult(ReservationView reservation, boolean released) {
    }

    /** Explicit release by orderId — reason EXPLICIT_RELEASE. */
    public ReleaseResult releaseByOrderId(String orderId, String reason) {
        return release(() -> reservationRepository.lockByOrderId(orderId), "orderId " + orderId, reason);
    }

    public ReleaseResult releaseByReservationId(UUID reservationId, String reason) {
        return release(() -> reservationRepository.lockById(reservationId), "reservationId " + reservationId, reason);
    }

    /**
     * reserved → available. Idempotent: if the hold is already in a terminal
     * state nothing changes and {@code released} is false. A CONFIRMED hold is
     * never released here: sold units come back through {@link #restockByOrderId}
     * / {@link #handleOrderCancelled} (status RESTOCKED), not through RELEASE.
     */
    private ReleaseResult release(Supplier<Optional<Reservation>> locker, String what, String reason) {
        String correlationId = Correlation.current();
        ReleaseResult result = tx.execute(status -> {
            Reservation reservation = locker.get().orElseThrow(() -> new ReservationNotFoundException(what));
            if (!reservation.isHeld()) {
                return new ReleaseResult(ReservationView.of(reservation), false);
            }
            releaseHeldInTransaction(reservation, ReservationStatus.RELEASED);
            return new ReleaseResult(ReservationView.of(reservation), true);
        });

        ReservationView r = result.reservation();
        if (result.released()) {
            log.info("hold RELEASED — units back to available", kv("orderId", r.orderId()), kv("reservationId", r.id()),
                    kv("reason", reason), kv("items", r.items()), kv("totalQuantity", r.totalQuantity()));
            publisher.publish(InventoryEvent.released(r, reason, correlationId));
        } else {
            log.info("release replayed — hold already terminal, nothing changed", kv("orderId", r.orderId()),
                    kv("reservationId", r.id()), kv("status", r.status()));
        }
        return result;
    }

    /**
     * Shared by release and the sweeper. Caller holds the reservation row lock
     * and has verified the hold is HELD. Locks the inventory rows in
     * {@link LockOrder} and moves every line back to available.
     */
    void releaseHeldInTransaction(Reservation reservation, ReservationStatus terminal) {
        for (var item : LockOrder.sorted(reservation.getItems(), i -> i.getProductId())) {
            Inventory inventory = inventoryRepository.lockByProductId(item.getProductId())
                    .orElseThrow(() -> new IllegalStateException("inventory row vanished for " + item.getProductId()));
            inventory.release(item.getQuantity());
        }
        reservation.resolve(terminal, clock.instant());
    }

    // -------------------------------------------------------------------------
    // RESTOCK (REST /restock, Kafka: OrderCancelled on a CONFIRMED hold)
    // -------------------------------------------------------------------------

    public record RestockResult(ReservationView reservation, boolean restocked) {
    }

    /**
     * (gone) -> available: the units of a CONFIRMED hold come back because the
     * paid order was cancelled. Same discipline as every other writer -
     * reservation row lock first, then inventory rows in {@link LockOrder} -
     * plus one extra guard that lives in the database: the status transition
     * is a conditional {@code UPDATE ... WHERE status = 'CONFIRMED'}
     * ({@link ReservationRepository#markRestockedIfConfirmed}). Stock is added
     * only when that statement changed exactly one row, so a duplicate
     * OrderCancelled, a concurrent retry or a replayed event can never
     * inflate stock: they find RESTOCKED and return {@code restocked = false}.
     *
     * @throws ReservationNotRestockableException for HELD / RELEASED / EXPIRED and,
     *         on this explicit API path, for an already RESTOCKED hold - the caller
     *         asked for something the lifecycle does not allow. (The Kafka path
     *         treats RESTOCKED as a silent replay instead: see handleOrderCancelled.)
     */
    public RestockResult restockByOrderId(String orderId, String reason) {
        String correlationId = Correlation.current();
        RestockResult result = tx.execute(status -> {
            Reservation reservation = reservationRepository.lockByOrderId(orderId)
                    .orElseThrow(() -> new ReservationNotFoundException("orderId " + orderId));
            return restockLockedInTransaction(reservation, orderId, true);
        });
        publishRestockOutcome(result, reason, correlationId);
        return result;
    }

    /**
     * Caller holds the reservation row lock. Applies the CAS, then the inventory updates.
     * {@code strict}: an already-RESTOCKED hold is an error (explicit API) instead of a replay (Kafka).
     */
    private RestockResult restockLockedInTransaction(Reservation reservation, String orderId, boolean strict) {
        ReservationView before = ReservationView.of(reservation);   // materialise the lines before the CAS clears the context
        if (before.status() == ReservationStatus.RESTOCKED) {
            if (strict) {
                throw new ReservationNotRestockableException(orderId, before.status().name());
            }
            return new RestockResult(before, false);
        }
        if (before.status() != ReservationStatus.CONFIRMED) {
            throw new ReservationNotRestockableException(orderId, before.status().name());
        }
        Instant now = clock.instant();
        int changed = reservationRepository.markRestockedIfConfirmed(before.id(), now);
        if (changed != 1) {
            // Cannot happen while holding the row lock - but the database, not this if-statement, is the
            // authority: no row changed, so no stock is added.
            log.warn("restock CAS changed no row - treating as already restocked", kv("orderId", orderId), kv("reservationId", before.id()));
            return new RestockResult(ReservationView.of(reservationRepository.findById(before.id()).orElseThrow()), false);
        }
        for (ReservationView.Line line : LockOrder.sorted(before.items(), ReservationView.Line::productId)) {
            Inventory inventory = inventoryRepository.lockByProductId(line.productId())
                    .orElseThrow(() -> new IllegalStateException("inventory row vanished for " + line.productId()));
            inventory.restock(line.quantity());
        }
        ReservationView after = new ReservationView(before.id(), before.orderId(), ReservationStatus.RESTOCKED, before.expiresAt(),
                before.createdAt(), now, before.items());
        return new RestockResult(after, true);
    }

    private void publishRestockOutcome(RestockResult result, String reason, String correlationId) {
        ReservationView r = result.reservation();
        if (result.restocked()) {
            log.info("hold RESTOCKED - sold units returned to available", kv("orderId", r.orderId()), kv("reservationId", r.id()),
                    kv("reason", reason), kv("items", r.items()), kv("totalQuantity", r.totalQuantity()));
            publisher.publish(InventoryEvent.restocked(r, reason, correlationId));
        } else {
            log.info("restock replayed - hold already RESTOCKED, nothing changed", kv("orderId", r.orderId()), kv("reservationId", r.id()));
        }
    }

    public enum CancelOutcome { RELEASED, RESTOCKED, ALREADY_DONE }

    /**
     * OrderCancelled from Kafka - one handler for both shapes of cancellation:
     * <ul>
     *   <li>HELD (unpaid order) -> RELEASE: reserved -> available (the existing behaviour);</li>
     *   <li>CONFIRMED (paid order, refund in flight at Payment) -> RESTOCK: (gone) -> available;</li>
     *   <li>RELEASED / EXPIRED / RESTOCKED -> nothing (idempotent replay).</li>
     * </ul>
     * Both branches run under the same reservation row lock, so a redelivered
     * event always sees the status the first delivery committed.
     */
    public CancelOutcome handleOrderCancelled(String orderId) {
        String correlationId = Correlation.current();
        record Outcome(CancelOutcome outcome, ReservationView view) {
        }
        Outcome outcome = tx.execute(status -> {
            Reservation reservation = reservationRepository.lockByOrderId(orderId)
                    .orElseThrow(() -> new ReservationNotFoundException("orderId " + orderId));
            switch (reservation.getStatus()) {
                case HELD -> {
                    releaseHeldInTransaction(reservation, ReservationStatus.RELEASED);
                    return new Outcome(CancelOutcome.RELEASED, ReservationView.of(reservation));
                }
                case CONFIRMED -> {
                    RestockResult r = restockLockedInTransaction(reservation, orderId, false);
                    return new Outcome(r.restocked() ? CancelOutcome.RESTOCKED : CancelOutcome.ALREADY_DONE, r.reservation());
                }
                default -> {
                    return new Outcome(CancelOutcome.ALREADY_DONE, ReservationView.of(reservation));
                }
            }
        });
        ReservationView r = outcome.view();
        switch (outcome.outcome()) {
            case RELEASED -> {
                log.info("hold RELEASED - units back to available", kv("orderId", r.orderId()), kv("reservationId", r.id()),
                        kv("reason", InventoryEvent.ReleaseReason.ORDER_CANCELLED), kv("items", r.items()), kv("totalQuantity", r.totalQuantity()));
                publisher.publish(InventoryEvent.released(r, InventoryEvent.ReleaseReason.ORDER_CANCELLED, correlationId));
            }
            case RESTOCKED -> publishRestockOutcome(new RestockResult(r, true), InventoryEvent.RestockReason.ORDER_CANCELLED, correlationId);
            case ALREADY_DONE -> log.info("OrderCancelled replayed - hold already " + r.status() + ", nothing changed",
                    kv("orderId", orderId), kv("reservationId", r.id()));
        }
        return outcome.outcome();
    }

    // -------------------------------------------------------------------------
    // STOCK QUERIES / ADMIN
    // -------------------------------------------------------------------------

    public StockView getStock(String productId) {
        return inventoryRepository.findById(productId).map(StockView::of)
                .orElseThrow(() -> new ProductNotFoundException(productId));
    }

    public record BulkStock(List<StockView> stock, List<String> unknown) {
    }

    /** One {@code WHERE product_id IN (...)} query, however many ids are asked for. */
    public BulkStock getStockBulk(List<String> productIds) {
        Map<String, StockView> found = new LinkedHashMap<>();
        for (Inventory i : inventoryRepository.findAllByProductIdIn(productIds)) {
            found.put(i.getProductId(), StockView.of(i));
        }
        List<StockView> stock = new ArrayList<>();
        List<String> unknown = new ArrayList<>();
        for (String id : productIds) {
            StockView v = found.get(id);
            if (v == null) {
                unknown.add(id);
            } else {
                stock.add(v);
            }
        }
        return new BulkStock(stock, unknown);
    }

    public enum AdjustOperation { SET, ADD }

    /**
     * Admin restock. SET makes available exactly {@code quantity}; ADD adds a
     * (possibly negative) delta. Creates the row if the product is unknown.
     * Locks the row like every other writer so it cannot interleave with a
     * reserve. reserved is never touched.
     */
    public StockView adjust(String productId, AdjustOperation operation, int quantity) {
        StockView view = tx.execute(status -> {
            Inventory inventory = inventoryRepository.lockByProductId(productId).orElse(null);
            if (inventory == null) {
                inventory = new Inventory(productId, 0);
            }
            try {
                switch (operation) {
                    case SET -> inventory.setAvailable(quantity);
                    case ADD -> inventory.addAvailable(quantity);
                }
            } catch (IllegalArgumentException e) {
                throw new InvalidAdjustmentException("adjustment would make available negative (available "
                        + inventory.getAvailable() + ", " + operation + " " + quantity + ")");
            }
            inventory = inventoryRepository.saveAndFlush(inventory);
            return StockView.of(inventory);
        });
        log.info("stock adjusted", kv("productId", productId), kv("operation", operation), kv("quantity", quantity),
                kv("available", view.available()), kv("reserved", view.reserved()));
        return view;
    }
}
