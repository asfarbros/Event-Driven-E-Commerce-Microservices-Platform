package com.orderflow.payment.service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import com.orderflow.payment.config.PaymentProperties;
import com.orderflow.payment.correlation.Correlation;
import com.orderflow.payment.domain.PaymentRefund;
import com.orderflow.payment.domain.PaymentRefundRepository;
import com.orderflow.payment.domain.PaymentStatus;
import com.orderflow.payment.domain.PaymentTransaction;
import com.orderflow.payment.domain.PaymentTransactionRepository;
import com.orderflow.payment.razorpay.RazorpayExceptions.Rejected;
import com.orderflow.payment.razorpay.RazorpayExceptions.Unavailable;
import com.orderflow.payment.razorpay.RazorpayGateway;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * RECONCILIATION — the safety net under the webhooks.
 *
 * <p>Why it is necessary even with webhooks: a webhook is a best-effort HTTP
 * call from Razorpay to us. It is lost if we were restarting, if the tunnel /
 * load balancer dropped it, if our database was briefly down (we answered 500
 * and Razorpay's retries ran out), or if the webhook was never configured for
 * an environment. Meanwhile the money HAS moved. Without this job the payment
 * would sit in PENDING forever: the customer paid, Inventory's hold expires,
 * the order never confirms. So every {@code PAYMENT_RECONCILE_INTERVAL_MS} this
 * job takes rows that have not changed for {@code PAYMENT_RECONCILE_AFTER_MS}
 * and asks Razorpay what actually happened:
 * <ul>
 *   <li>CREATED (no Razorpay order known): look the order up by receipt (= our
 *       orderId). Found → attach it and continue as PENDING. Not found after
 *       {@code PAYMENT_ABANDON_AFTER_MS} → FAILED ("gateway order never created")
 *       + PaymentFailed, so Order can cancel and release the stock.</li>
 *   <li>PENDING: list the order's payments. A captured one with our amount →
 *       SUCCESS + PaymentSucceeded. Nothing captured after the abandon window →
 *       FAILED ("abandoned") + PaymentFailed. Otherwise leave it: the user may
 *       still be on the OTP screen.</li>
 *   <li>REFUND_PENDING: resume or confirm the refund (see PaymentService).</li>
 * </ul>
 * Each row is handled in its own transaction under {@code FOR UPDATE SKIP
 * LOCKED}, so a webhook arriving at the same moment and a second instance of
 * this job cannot double-apply anything. Razorpay being unavailable just
 * postpones the row to the next run.
 */
@Component
@ConditionalOnProperty(name = "payment.reconciliation.enabled", havingValue = "true", matchIfMissing = true)
public class ReconciliationJob {

    private static final Logger log = LoggerFactory.getLogger(ReconciliationJob.class);

    private final PaymentTransactionRepository transactions;
    private final PaymentRefundRepository refunds;
    private final RazorpayGateway gateway;
    private final PaymentEventPublisher publisher;
    private final PaymentService paymentService;
    private final PaymentProperties.Reconciliation config;
    private final TransactionTemplate tx;
    private final Clock clock;

    private final AtomicReference<Instant> lastRunAt = new AtomicReference<>();
    private final AtomicLong lastRunResolved = new AtomicLong();
    private final AtomicLong totalResolved = new AtomicLong();

    public ReconciliationJob(PaymentTransactionRepository transactions, PaymentRefundRepository refunds, RazorpayGateway gateway,
                             PaymentEventPublisher publisher, PaymentService paymentService, PaymentProperties properties,
                             PlatformTransactionManager transactionManager, Clock clock) {
        this.transactions = transactions;
        this.refunds = refunds;
        this.gateway = gateway;
        this.publisher = publisher;
        this.paymentService = paymentService;
        this.config = properties.reconciliation();
        this.tx = new TransactionTemplate(transactionManager);
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${payment.reconciliation.interval-ms}", initialDelayString = "${payment.reconciliation.interval-ms}")
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

    /** Package-private for tests / manual triggers. Returns the number of rows that changed state. */
    public int reconcile() {
        Instant before = clock.instant().minus(Duration.ofMillis(config.stuckAfterMs()));
        List<UUID> ids = transactions.findStuckIds(before, config.batchSize());
        if (ids.isEmpty()) {
            return 0;
        }
        log.info("reconciliation: examining stuck payments", kv("count", ids.size()), kv("olderThan", before));
        int resolved = 0;
        for (UUID id : ids) {
            try {
                if (reconcileOne(id)) {
                    resolved++;
                }
            } catch (Unavailable e) {
                log.warn("reconciliation: razorpay unavailable — leaving row for the next run", kv("paymentId", id), kv("error", e.getMessage()));
            } catch (RuntimeException e) {
                log.error("reconciliation: unexpected failure for one row — continuing", kv("paymentId", id), e);
            }
        }
        return resolved;
    }

    private boolean reconcileOne(UUID id) {
        record Outcome(boolean changed, PaymentEvent event) {
        }
        Outcome outcome = tx.execute(s -> {
            Optional<PaymentTransaction> locked = transactions.lockStuck(id);
            if (locked.isEmpty()) {
                return new Outcome(false, null);   // settled meanwhile, or another worker has it
            }
            PaymentTransaction p = locked.get();
            Instant now = clock.instant();
            boolean pastAbandon = Duration.between(p.getCreatedAt(), now).toMillis() >= config.abandonAfterMs();

            if (p.getStatus() == PaymentStatus.CREATED) {
                List<RazorpayGateway.Order> orders = gateway.findOrdersByReceipt(p.getOrderId());
                RazorpayGateway.Order match = orders.stream()
                        .filter(o -> o.amount() == p.getAmountInPaise() && p.getCurrency().equals(o.currency()))
                        .findFirst().orElse(null);
                if (match != null) {
                    p.attachGatewayOrder(match.id());
                    log.warn("reconciliation: found a razorpay order we never recorded — attached", kv("orderId", p.getOrderId()),
                            kv("paymentId", p.getId()), kv("razorpayOrderId", match.id()));
                    // fall through to the PENDING check below
                } else if (pastAbandon) {
                    p.markFailed(null, "abandoned: no gateway order was created within " + config.abandonAfterMs() + " ms"
                            + (p.getLastGatewayError() != null ? " (last error: " + p.getLastGatewayError() + ")" : ""));
                    log.warn("reconciliation: payment FAILED — never reached razorpay", kv("orderId", p.getOrderId()), kv("paymentId", p.getId()));
                    return new Outcome(true, PaymentEvent.failed(PaymentView.of(p, null), Correlation.current()));
                } else {
                    return new Outcome(false, null);
                }
            }

            if (p.getStatus() == PaymentStatus.PENDING) {
                List<RazorpayGateway.Payment> attempts = gateway.listOrderPayments(p.getRazorpayOrderId());
                RazorpayGateway.Payment captured = attempts.stream()
                        .filter(RazorpayGateway.Payment::isCaptured).filter(a -> a.amount() == p.getAmountInPaise())
                        .findFirst().orElse(null);
                if (captured != null) {
                    p.markSuccess(captured.id());
                    log.warn("reconciliation: payment was CAPTURED at razorpay but we never got the webhook — now SUCCESS",
                            kv("orderId", p.getOrderId()), kv("paymentId", p.getId()), kv("razorpayPaymentId", captured.id()),
                            kv("amountInPaise", captured.amount()), kv("attempts", attempts.size()));
                    return new Outcome(true, PaymentEvent.succeeded(PaymentView.of(p, null), Correlation.current()));
                }
                if (pastAbandon) {
                    RazorpayGateway.Payment lastFailed = attempts.stream().filter(RazorpayGateway.Payment::isFailed)
                            .reduce((a, b) -> b).orElse(null);
                    String reason = lastFailed != null
                            ? "abandoned after failed attempt: " + firstNonNull(lastFailed.errorDescription(), lastFailed.errorReason(), lastFailed.errorCode())
                            : "abandoned: no payment attempt captured within " + config.abandonAfterMs() + " ms";
                    p.markFailed(lastFailed != null ? lastFailed.id() : null, reason);
                    log.warn("reconciliation: payment FAILED (abandoned)", kv("orderId", p.getOrderId()), kv("paymentId", p.getId()),
                            kv("attempts", attempts.size()), kv("failureReason", reason));
                    return new Outcome(true, PaymentEvent.failed(PaymentView.of(p, null), Correlation.current()));
                }
                log.debug("reconciliation: still within the payment window", kv("orderId", p.getOrderId()), kv("attempts", attempts.size()));
                return new Outcome(false, null);
            }

            if (p.getStatus() == PaymentStatus.REFUND_PENDING) {
                PaymentRefund r = refunds.lockByPaymentId(p.getId()).orElse(null);
                if (r == null) {
                    // Inconsistent (should not happen): create the missing refund row so the normal path can proceed.
                    r = new PaymentRefund(p, "reconciliation", null, Correlation.current());
                    refunds.saveAndFlush(r);
                }
                return new Outcome(false, null);   // handled below, outside this transaction
            }
            return new Outcome(false, null);
        });

        if (outcome.event() != null) {
            publisher.publish(outcome.event());
        }
        if (outcome.changed()) {
            return true;
        }

        // REFUND_PENDING rows: resume / confirm with Razorpay via the shared refund path.
        PaymentStatus status = tx.execute(s -> transactions.findById(id).map(PaymentTransaction::getStatus).orElse(null));
        if (status == PaymentStatus.REFUND_PENDING) {
            try {
                PaymentService.RefundResult r = paymentService.settleRefundWithGateway(id, Correlation.current());
                if (r.outcome() == PaymentService.RefundOutcome.REFUNDED) {
                    log.warn("reconciliation: refund confirmed with razorpay — payment REFUNDED", kv("paymentId", id));
                    return true;
                }
            } catch (Rejected e) {
                // already recorded on the refund row by settleRefundWithGateway
                return true;
            }
        }
        return false;
    }

    private static String firstNonNull(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) return v;
        }
        return "unknown";
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
