package com.orderflow.order.service;

import java.time.Clock;
import java.util.UUID;

import com.orderflow.order.clients.Clients;
import com.orderflow.order.clients.ServiceClient;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import com.orderflow.order.domain.Order;
import com.orderflow.order.domain.Order.PaymentState;
import com.orderflow.order.domain.Order.Trigger;
import com.orderflow.order.domain.OrderStatus;
import com.orderflow.order.domain.ProcessedEvent;
import com.orderflow.order.domain.OrderRepository;
import com.orderflow.order.domain.OutboxRepository;
import com.orderflow.order.domain.ProcessedEventRepository;
import com.orderflow.order.outbox.OutboxRelay;
import com.orderflow.order.outbox.OutboxWriter;
import com.orderflow.order.service.ServiceExceptions.CancelNotAllowedException;
import com.orderflow.order.service.ServiceExceptions.OrderNotFoundException;
import com.orderflow.order.service.ServiceExceptions.OrderNotReadyException;
import com.orderflow.order.service.ServiceExceptions.UnknownOrderException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Everything that happens to an order AFTER checkout: reads (ownership
 * enforced), user cancellation, and the application of Kafka events — all
 * through {@link Order#transitionTo} (the state machine) inside one
 * transaction per change, with the outbox written alongside.
 */
@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    public static final String SEND_CONFIRMATION = "SendOrderConfirmation";
    public static final String SEND_CANCELLATION = "SendOrderCancellation";

    private final OrderRepository orders;
    private final ProcessedEventRepository processedEvents;
    private final OutboxWriter outbox;
    private final OutboxRelay relay;
    private final Clients.Inventory inventory;
    private final OrderProperties properties;
    private final TransactionTemplate tx;
    private final TransactionTemplate readOnlyTx;
    private final Clock clock;

    public OrderService(OrderRepository orders, ProcessedEventRepository processedEvents, OutboxWriter outbox, OutboxRelay relay,
                        Clients.Inventory inventory, OrderProperties properties, PlatformTransactionManager transactionManager, Clock clock) {
        this.orders = orders;
        this.processedEvents = processedEvents;
        this.outbox = outbox;
        this.relay = relay;
        this.inventory = inventory;
        this.properties = properties;
        this.tx = new TransactionTemplate(transactionManager);
        this.readOnlyTx = new TransactionTemplate(transactionManager);
        this.readOnlyTx.setReadOnly(true);
        this.clock = clock;
    }

    // -------------------------------------------------------------------------
    // READS — every query is scoped to the caller: another user's order is 404
    // -------------------------------------------------------------------------

    public OrderView get(String userId, UUID orderId) {
        return readOnlyTx.execute(s -> orders.findByIdAndUserId(orderId, userId).map(o -> OrderView.of(o, true))
                .orElseThrow(() -> new OrderNotFoundException(orderId.toString())));
    }

    public record PageResult(java.util.List<OrderView> items, int page, int limit, long total, int totalPages) {
    }

    public PageResult list(String userId, int page, int limit) {
        return readOnlyTx.execute(s -> {
            Page<Order> p = orders.findByUserId(userId, PageRequest.of(page - 1, limit, Sort.by(Sort.Direction.DESC, "createdAt")));
            return new PageResult(p.getContent().stream().map(o -> OrderView.of(o, false)).toList(), page, limit,
                    p.getTotalElements(), Math.max(1, p.getTotalPages()));
        });
    }

    // -------------------------------------------------------------------------
    // USER CANCELLATION
    // -------------------------------------------------------------------------

    public record CancelResult(OrderView order, boolean cancelled) {
    }

    /**
     * AWAITING_PAYMENT → CANCELLED: the hold is released (sync call, and the
     * OrderCancelled event as the durable backstop). CONFIRMED → CANCELLED: the
     * same OrderCancelled event makes Payment refund AND makes Inventory restock
     * the CONFIRMED hold (sold units back to available; InventoryRestocked comes
     * back and is noted in the history). Terminal → no-op.
     */
    public CancelResult cancel(String userId, UUID orderId, String reason) {
        String requestId = Correlation.current();
        CancelResult result = tx.execute(s -> {
            Order o = orders.lockByIdAndUserId(orderId, userId).orElseThrow(() -> new OrderNotFoundException(orderId.toString()));
            if (o.getStatus().isTerminal()) {
                return new CancelResult(OrderView.of(o, true), false);
            }
            if (!o.getStatus().isUserCancellable()) {
                throw new CancelNotAllowedException(o.getStatus().name());
            }
            boolean wasPaid = o.getStatus() == OrderStatus.CONFIRMED;
            String why = wasPaid ? "cancelled by user after payment — refund requested" : "cancelled by user before payment";
            if (reason != null && !reason.isBlank()) {
                why += " (" + reason + ")";
            }
            o.transitionTo(OrderStatus.CANCELLED, Trigger.USER, why, null, requestId);
            if (wasPaid) {
                o.setPaymentStatus(PaymentState.REFUND_PENDING);
            }
            outbox.orderEvent(o, OutboxWriter.ORDER_CANCELLED, why);
            outbox.notification(o, OutboxWriter.ROUTING_CANCELLED, SEND_CANCELLATION, why);
            relay.nudgeAfterCommit();
            log.info("order CANCELLED by user", kv("orderId", o.getId()), kv("wasPaid", wasPaid), kv("reason", why));
            return new CancelResult(OrderView.of(o, true), true);
        });
        if (result.cancelled() && result.order().paymentStatus() == PaymentState.UNPAID) {
            releaseHoldBestEffort(orderId);
        }
        return result;
    }

    /** Sync release for snappy stock return; the OrderCancelled event already queued is the durable fallback. */
    void releaseHoldBestEffort(UUID orderId) {
        try {
            inventory.release(orderId.toString());
        } catch (ServiceClient.Unavailable | ServiceClient.Rejected e) {
            log.warn("inventory release call failed — OrderCancelled event will release the hold", kv("orderId", orderId), kv("error", e.getMessage()));
        }
    }

    // -------------------------------------------------------------------------
    // KAFKA EVENTS (payment-events, inventory-events) — idempotent, ordered by the state machine
    // -------------------------------------------------------------------------

    public enum Outcome { APPLIED, DUPLICATE, IGNORED_STALE, NOTED }

    /**
     * Applies one event inside one transaction:
     * <ol>
     *   <li>processed_event lookup → DUPLICATE (nothing happens, ack).</li>
     *   <li>row lock on the order → unknown → {@link UnknownOrderException} (not retried: DLT immediately —
     *       the PENDING row is committed before any downstream call, so it can only be foreign data).</li>
     *   <li>the transition per event type (below); an illegal transition means
     *       the event is STALE for the order's current state → recorded and ignored,
     *       never applied over a terminal state.</li>
     *   <li>processed_event insert (PK = eventId) + outbox rows, same transaction.</li>
     * </ol>
     */
    public Outcome applyEvent(String topic, String eventId, String eventType, String orderIdText, String detail) {
        String requestId = Correlation.current();
        Outcome outcome = tx.execute(s -> {
            if (processedEvents.existsById(eventId)) {
                return Outcome.DUPLICATE;
            }
            UUID orderId;
            try {
                orderId = UUID.fromString(orderIdText);
            } catch (IllegalArgumentException e) {
                throw new UnknownOrderException(orderIdText);
            }
            Order o = orders.lockById(orderId).orElseThrow(() -> new UnknownOrderException(orderIdText));
            Outcome result;
            try {
                result = switch (eventType) {
                    case "PaymentSucceeded" -> onPaymentSucceeded(o, eventId, requestId);
                    case "PaymentFailed" -> onPaymentFailed(o, eventId, requestId, detail);
                    case "PaymentRefunded" -> onPaymentRefunded(o, eventId, requestId);
                    case "InventoryReleased" -> onInventoryReleased(o, eventId, requestId, detail);
                    case "InventoryConfirmFailed" -> onInventoryConfirmFailed(o, eventId, requestId);
                    case "InventoryRestocked" -> onInventoryRestocked(o, eventId, requestId);
                    default -> Outcome.NOTED;
                };
            } catch (OrderStatus.IllegalTransitionException e) {
                log.warn("STALE event ignored — would violate the state machine", kv("orderId", o.getId()), kv("eventType", eventType),
                        kv("eventId", eventId), kv("currentStatus", e.getFrom()), kv("attempted", e.getTo()));
                o.note(Trigger.PAYMENT_EVENT, "stale " + eventType + " ignored (would move " + e.getFrom() + " -> " + e.getTo() + ")", eventId, requestId);
                result = Outcome.IGNORED_STALE;
            }
            processedEvents.save(new ProcessedEvent(eventId, topic, eventType, orderIdText, result.name(), clock.instant()));
            relay.nudgeAfterCommit();
            return result;
        });
        log.info("event " + outcome, kv("eventType", eventType), kv("eventId", eventId), kv("orderId", orderIdText));
        return outcome;
    }

    private Outcome onPaymentSucceeded(Order o, String eventId, String requestId) {
        switch (o.getStatus()) {
            case AWAITING_PAYMENT -> {
                o.transitionTo(OrderStatus.CONFIRMED, Trigger.PAYMENT_EVENT, "payment succeeded", eventId, requestId);
                o.setPaymentStatus(PaymentState.PAID);
                outbox.orderEvent(o, OutboxWriter.ORDER_CONFIRMED, null);
                outbox.notification(o, OutboxWriter.ROUTING_CONFIRMED, SEND_CONFIRMATION, null);
                log.info("order CONFIRMED", kv("orderId", o.getId()), kv("totalInPaise", o.getTotalInPaise()));
                return Outcome.APPLIED;
            }
            case CONFIRMED -> {
                return Outcome.DUPLICATE;   // state machine: already there, no side effects
            }
            case PENDING, RESERVED -> throw new OrderNotReadyException(o.getId().toString(), o.getStatus().name());
            case FAILED, CANCELLED -> {
                // Money landed for an order that is already dead (user cancelled at the last second, or the hold
                // expired first). Never keep it: ask Payment to refund via OrderCancelled. Inventory replays harmlessly.
                o.setPaymentStatus(PaymentState.REFUND_PENDING);
                o.note(Trigger.PAYMENT_EVENT, "payment succeeded AFTER the order was " + o.getStatus() + " — refund requested", eventId, requestId);
                outbox.orderEvent(o, OutboxWriter.ORDER_CANCELLED, "payment received after " + o.getStatus() + " — refund");
                log.warn("payment landed on a terminal order — refund requested", kv("orderId", o.getId()), kv("status", o.getStatus()));
                return Outcome.APPLIED;
            }
        }
        return Outcome.NOTED;
    }

    private Outcome onPaymentFailed(Order o, String eventId, String requestId, String failureReason) {
        if (o.getStatus() == OrderStatus.AWAITING_PAYMENT) {
            String why = "payment failed" + (failureReason != null ? ": " + failureReason : "");
            o.transitionTo(OrderStatus.FAILED, Trigger.PAYMENT_EVENT, why, eventId, requestId);
            outbox.orderEvent(o, OutboxWriter.ORDER_CANCELLED, why);          // Inventory releases the hold
            outbox.notification(o, OutboxWriter.ROUTING_CANCELLED, SEND_CANCELLATION, why);
            log.warn("order FAILED — payment failed", kv("orderId", o.getId()), kv("reason", why));
            return Outcome.APPLIED;
        }
        if (o.getStatus() == OrderStatus.FAILED) {
            return Outcome.DUPLICATE;
        }
        // CONFIRMED (a failed attempt before the successful one, delivered late) or terminal: stale.
        o.note(Trigger.PAYMENT_EVENT, "stale PaymentFailed ignored (order is " + o.getStatus() + ")", eventId, requestId);
        return Outcome.IGNORED_STALE;
    }

    private Outcome onPaymentRefunded(Order o, String eventId, String requestId) {
        if (o.getPaymentStatus() == PaymentState.REFUNDED) {
            return Outcome.DUPLICATE;
        }
        o.setPaymentStatus(PaymentState.REFUNDED);
        o.note(Trigger.PAYMENT_EVENT, "refund processed by Payment Service", eventId, requestId);
        log.info("order refund completed", kv("orderId", o.getId()), kv("status", o.getStatus()));
        return Outcome.APPLIED;
    }

    private Outcome onInventoryReleased(Order o, String eventId, String requestId, String reason) {
        if (!"EXPIRED".equals(reason)) {
            return Outcome.NOTED;   // ORDER_CANCELLED / EXPLICIT_RELEASE: we caused it
        }
        if (o.getStatus() == OrderStatus.AWAITING_PAYMENT) {
            String why = "stock hold expired before payment";
            o.transitionTo(OrderStatus.CANCELLED, Trigger.INVENTORY_EVENT, why, eventId, requestId);
            outbox.orderEvent(o, OutboxWriter.ORDER_CANCELLED, why);          // Payment: unpaid → no-op; a late payment → refund path
            outbox.notification(o, OutboxWriter.ROUTING_CANCELLED, SEND_CANCELLATION, why);
            log.warn("order CANCELLED — hold expired", kv("orderId", o.getId()));
            return Outcome.APPLIED;
        }
        if (o.getStatus() == OrderStatus.CANCELLED) {
            return Outcome.DUPLICATE;
        }
        o.note(Trigger.INVENTORY_EVENT, "InventoryReleased(EXPIRED) ignored (order is " + o.getStatus() + ")", eventId, requestId);
        return Outcome.IGNORED_STALE;
    }

    /**
     * Inventory returned the sold units of a cancelled PAID order to stock (the
     * other half of the compensation next to Payment's refund). No status
     * change — the order is already CANCELLED — just the audit trail.
     */
    private Outcome onInventoryRestocked(Order o, String eventId, String requestId) {
        o.note(Trigger.INVENTORY_EVENT, "stock restocked by Inventory (units returned to available)", eventId, requestId);
        log.info("order stock RESTOCKED by Inventory", kv("orderId", o.getId()), kv("status", o.getStatus()), kv("paymentStatus", o.getPaymentStatus()));
        return Outcome.APPLIED;
    }

    /** Payment landed after the hold expired: stock may be gone. Money must not be kept — cancel + refund. */
    private Outcome onInventoryConfirmFailed(Order o, String eventId, String requestId) {
        if (o.getStatus() == OrderStatus.CONFIRMED) {
            String why = "stock could not be confirmed after payment — cancelled, refund requested";
            o.transitionTo(OrderStatus.CANCELLED, Trigger.INVENTORY_EVENT, why, eventId, requestId);
            o.setPaymentStatus(PaymentState.REFUND_PENDING);
            outbox.orderEvent(o, OutboxWriter.ORDER_CANCELLED, why);          // Payment refunds
            outbox.notification(o, OutboxWriter.ROUTING_CANCELLED, SEND_CANCELLATION, why);
            log.error("order CANCELLED after payment — inventory could not confirm the hold", kv("orderId", o.getId()));
            return Outcome.APPLIED;
        }
        if (o.getStatus() == OrderStatus.CANCELLED) {
            return Outcome.DUPLICATE;
        }
        o.note(Trigger.INVENTORY_EVENT, "InventoryConfirmFailed ignored (order is " + o.getStatus() + ")", eventId, requestId);
        return Outcome.IGNORED_STALE;
    }

    public OrderProperties properties() {
        return properties;
    }
}
