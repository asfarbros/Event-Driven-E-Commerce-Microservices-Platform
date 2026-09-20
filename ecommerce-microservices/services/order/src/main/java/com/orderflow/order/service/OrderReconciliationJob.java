package com.orderflow.order.service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import com.orderflow.order.clients.Clients;
import com.orderflow.order.clients.ServiceClient;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import com.orderflow.order.domain.Order;
import com.orderflow.order.domain.Order.PaymentState;
import com.orderflow.order.domain.Order.Trigger;
import com.orderflow.order.domain.OrderStatus;
import com.orderflow.order.domain.OrderRepository;
import com.orderflow.order.domain.OutboxRepository;
import com.orderflow.order.domain.ProcessedEventRepository;
import com.orderflow.order.outbox.OutboxRelay;
import com.orderflow.order.outbox.OutboxWriter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * ORDER RECONCILIATION — the safety net for the asynchronous zone.
 *
 * <p>Why it is needed even though Payment gets webhooks and publishes events:
 * this service learns the outcome only through Kafka. If those records were
 * never produced (Payment's own outage), were dead-lettered here after
 * retries, or arrived while this service was down for longer than retention,
 * an order would sit in AWAITING_PAYMENT forever — Inventory's hold expires,
 * but the customer may have paid. So every {@code ORDER_RECONCILE_INTERVAL_MS}
 * this job takes orders unchanged in AWAITING_PAYMENT for
 * {@code ORDER_RECONCILE_AFTER_MS} and asks Payment Service directly:
 * <ul>
 *   <li>SUCCESS / REFUND_PENDING / REFUNDED → CONFIRMED (+ OrderConfirmed, notification) —
 *       the same effect the missing PaymentSucceeded would have had;</li>
 *   <li>FAILED → FAILED (+ OrderCancelled so Inventory releases);</li>
 *   <li>CREATED / PENDING / no payment, older than {@code ORDER_ABANDON_AFTER_MS}
 *       → CANCELLED "abandoned" (+ OrderCancelled). A payment that lands after
 *       that is refunded by the PaymentSucceeded-on-terminal path.</li>
 * </ul>
 * Rows are locked {@code FOR UPDATE SKIP LOCKED} one at a time, so an event
 * arriving at the same moment cannot double-apply. Payment being unavailable
 * just postpones the row.
 */
@Component
@ConditionalOnProperty(name = "order.reconciliation.enabled", havingValue = "true", matchIfMissing = true)
public class OrderReconciliationJob {

    private static final Logger log = LoggerFactory.getLogger(OrderReconciliationJob.class);

    private final OrderRepository orders;
    private final Clients.Payment payment;
    private final OutboxWriter outbox;
    private final OutboxRelay relay;
    private final OrderProperties.Reconciliation config;
    private final TransactionTemplate tx;
    private final Clock clock;

    private final AtomicReference<Instant> lastRunAt = new AtomicReference<>();
    private final AtomicLong lastRunResolved = new AtomicLong();
    private final AtomicLong totalResolved = new AtomicLong();

    public OrderReconciliationJob(OrderRepository orders, Clients.Payment payment, OutboxWriter outbox, OutboxRelay relay,
                                  OrderProperties properties, PlatformTransactionManager transactionManager, Clock clock) {
        this.orders = orders;
        this.payment = payment;
        this.outbox = outbox;
        this.relay = relay;
        this.config = properties.reconciliation();
        this.tx = new TransactionTemplate(transactionManager);
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${order.reconciliation.interval-ms}", initialDelayString = "${order.reconciliation.interval-ms}")
    public void run() {
        Correlation.set(Correlation.newId("reconcile"));
        try {
            int resolved = reconcile();
            lastRunAt.set(clock.instant());
            lastRunResolved.set(resolved);
            totalResolved.addAndGet(resolved);
            if (resolved > 0) {
                log.info("reconciliation finished", kv("resolved", resolved));
            } else {
                log.debug("reconciliation finished — nothing to resolve");
            }
        } catch (RuntimeException e) {
            log.error("reconciliation run failed — will retry on the next interval", e);
        } finally {
            Correlation.clear();
        }
    }

    public int reconcile() {
        Instant before = clock.instant().minus(Duration.ofMillis(config.stuckAfterMs()));
        List<UUID> ids = orders.findStuckAwaitingPayment(before, config.batchSize());
        if (ids.isEmpty()) {
            return 0;
        }
        log.info("reconciliation: examining orders stuck in AWAITING_PAYMENT", kv("count", ids.size()), kv("olderThan", before));
        int resolved = 0;
        for (UUID id : ids) {
            try {
                if (reconcileOne(id)) {
                    resolved++;
                }
            } catch (ServiceClient.Unavailable e) {
                log.warn("reconciliation: payment service unavailable — leaving order for the next run", kv("orderId", id), kv("error", e.getMessage()));
            } catch (RuntimeException e) {
                log.error("reconciliation: unexpected failure for one order — continuing", kv("orderId", id), e);
            }
        }
        return resolved;
    }

    private boolean reconcileOne(UUID id) {
        // Ask Payment first (outside the lock): the answer decides the transition.
        Clients.Payment.Status status = payment.status(id.toString());
        String requestId = Correlation.current();
        Boolean changed = tx.execute(s -> {
            Optional<Order> locked = orders.lockStuck(id);
            if (locked.isEmpty()) {
                return false;   // an event resolved it meanwhile
            }
            Order o = locked.get();
            String eventId = "reconcile-" + id + "-" + clock.instant().toEpochMilli();
            String paymentState = status != null ? status.status() : "NONE";
            switch (paymentState) {
                case "SUCCESS", "REFUND_PENDING", "REFUNDED" -> {
                    o.transitionTo(OrderStatus.CONFIRMED, Trigger.RECONCILIATION, "payment service reports " + paymentState + " (event was missed)", eventId, requestId);
                    o.setPaymentStatus("SUCCESS".equals(paymentState) ? PaymentState.PAID : "REFUNDED".equals(paymentState) ? PaymentState.REFUNDED : PaymentState.REFUND_PENDING);
                    outbox.orderEvent(o, OutboxWriter.ORDER_CONFIRMED, null);
                    outbox.notification(o, OutboxWriter.ROUTING_CONFIRMED, OrderService.SEND_CONFIRMATION, null);
                    log.warn("reconciliation: order CONFIRMED — payment had succeeded but no event reached us", kv("orderId", id), kv("razorpayPaymentId", status.razorpayPaymentId()));
                }
                case "FAILED" -> {
                    String why = "payment failed" + (status.failureReason() != null ? ": " + status.failureReason() : "") + " (reconciliation)";
                    o.transitionTo(OrderStatus.FAILED, Trigger.RECONCILIATION, why, eventId, requestId);
                    outbox.orderEvent(o, OutboxWriter.ORDER_CANCELLED, why);
                    outbox.notification(o, OutboxWriter.ROUTING_CANCELLED, OrderService.SEND_CANCELLATION, why);
                    log.warn("reconciliation: order FAILED — payment failed", kv("orderId", id));
                }
                default -> {
                    boolean pastAbandon = Duration.between(o.getCreatedAt(), clock.instant()).toMillis() >= config.abandonAfterMs();
                    if (!pastAbandon) {
                        log.debug("reconciliation: still inside the payment window", kv("orderId", id), kv("paymentState", paymentState));
                        return false;
                    }
                    String why = "abandoned: no payment after " + config.abandonAfterMs() + " ms (payment service reports " + paymentState + ")";
                    o.transitionTo(OrderStatus.CANCELLED, Trigger.RECONCILIATION, why, eventId, requestId);
                    outbox.orderEvent(o, OutboxWriter.ORDER_CANCELLED, why);   // Inventory releases (if the sweeper has not already)
                    outbox.notification(o, OutboxWriter.ROUTING_CANCELLED, OrderService.SEND_CANCELLATION, why);
                    log.warn("reconciliation: order CANCELLED — abandoned checkout", kv("orderId", id));
                }
            }
            relay.nudgeAfterCommit();
            return true;
        });
        return Boolean.TRUE.equals(changed);
    }

    public Instant lastRunAt() {
        return lastRunAt.get();
    }

    public long lastRunResolved() {
        return lastRunResolved.get();
    }

    public long totalResolved() {
        return totalResolved.get();
    }
}
