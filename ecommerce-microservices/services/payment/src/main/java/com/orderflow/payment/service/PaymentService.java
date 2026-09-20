package com.orderflow.payment.service;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

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
import com.orderflow.payment.service.ServiceExceptions.NothingToRefundException;
import com.orderflow.payment.service.ServiceExceptions.PaymentNotFoundException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Payment creation and refunds. (Webhooks: {@link WebhookService};
 * missed webhooks: {@link ReconciliationJob}.)
 *
 * <p>Discipline, as in Inventory: explicit {@link TransactionTemplate}
 * boundaries, row locks ({@code FOR UPDATE}) on the transaction row for every
 * state change, Kafka events published only AFTER commit.
 *
 * <p>One deliberate difference: the row lock is held ACROSS the outbound
 * Razorpay call that creates an order or a refund. That is what makes "one
 * Razorpay order per order id" and "one refund per payment" true even under a
 * retry storm: a concurrent caller waits on the lock (bounded by
 * PAYMENT_LOCK_TIMEOUT_MS ≥ RAZORPAY_TIMEOUT_MS), then sees the result the
 * first caller committed and returns it. The database UNIQUE constraints are
 * the backstop if anything slips past the locks.
 */
@Service
public class PaymentService {

    private static final Logger log = LoggerFactory.getLogger(PaymentService.class);

    private final PaymentTransactionRepository transactions;
    private final PaymentRefundRepository refunds;
    private final RazorpayGateway gateway;
    private final PaymentEventPublisher publisher;
    private final PaymentProperties properties;
    private final TransactionTemplate tx;
    private final TransactionTemplate readOnlyTx;
    private final Clock clock;

    public PaymentService(PaymentTransactionRepository transactions, PaymentRefundRepository refunds,
                          RazorpayGateway gateway, PaymentEventPublisher publisher, PaymentProperties properties,
                          PlatformTransactionManager transactionManager, Clock clock) {
        this.transactions = transactions;
        this.refunds = refunds;
        this.gateway = gateway;
        this.publisher = publisher;
        this.properties = properties;
        this.tx = new TransactionTemplate(transactionManager);
        this.readOnlyTx = new TransactionTemplate(transactionManager);
        this.readOnlyTx.setReadOnly(true);
        this.clock = clock;
    }

    // -------------------------------------------------------------------------
    // CREATE (POST /payments — server-to-server from Order Service)
    // -------------------------------------------------------------------------

    /** {@code created} is false on an idempotent replay (the order already had a payment). */
    public record CreateResult(PaymentView payment, boolean created) {
    }

    /**
     * 1. Write OUR row first (status CREATED) so a payment attempt exists before
     *    any external call — nothing can happen at Razorpay that we have no
     *    record of.
     * 2. Under the row lock, create the Razorpay order with EXACTLY the amount
     *    stored in step 1 (the amount comes from the trusted server caller and
     *    is recorded by us; the browser only ever sees it, never sets it), verify
     *    Razorpay echoed the same amount and currency, store the razorpay order
     *    id → PENDING.
     *
     * <p>Idempotent on orderId: an existing row is returned (created=false). A
     * row still CREATED because an earlier Razorpay call failed gets the
     * Razorpay step retried — still one row, still at most one Razorpay order.
     */
    public CreateResult create(String orderId, String userId, long amountInPaise, String currency) {
        String requestId = Correlation.current();

        boolean created = false;
        UUID paymentId;
        Optional<PaymentTransaction> existing = readOnlyTx.execute(s -> transactions.findByOrderId(orderId));
        if (existing.isPresent()) {
            paymentId = existing.get().getId();
            if (existing.get().getStatus() != PaymentStatus.CREATED) {
                log.info("payment replayed — returning existing", kv("orderId", orderId), kv("paymentId", paymentId),
                        kv("status", existing.get().getStatus()));
                return new CreateResult(view(paymentId), false);
            }
        } else {
            try {
                paymentId = tx.execute(s -> {
                    PaymentTransaction p = new PaymentTransaction(orderId, userId, amountInPaise, currency, requestId);
                    transactions.saveAndFlush(p);
                    return p.getId();
                });
                created = true;
                log.info("payment row CREATED", kv("orderId", orderId), kv("paymentId", paymentId),
                        kv("amountInPaise", amountInPaise), kv("currency", currency));
            } catch (DataIntegrityViolationException e) {
                // Lost the insert race on UNIQUE(order_id): the winner's row is the payment.
                PaymentTransaction winner = readOnlyTx.execute(s -> transactions.findByOrderId(orderId)).orElseThrow(() -> e);
                paymentId = winner.getId();
                log.info("payment insert race — using existing row", kv("orderId", orderId), kv("paymentId", paymentId));
            }
        }

        PaymentView view = ensureGatewayOrder(paymentId, requestId);
        return new CreateResult(view, created);
    }

    /**
     * CREATED → PENDING. Locks the row, creates the Razorpay order while
     * holding the lock, records the outcome — success, gateway unavailable
     * (row stays CREATED with last_gateway_error; caller gets a 503 and may
     * retry; reconciliation also picks it up) or gateway rejected (row → FAILED
     * with the reason; PaymentFailed published so Order can react).
     */
    PaymentView ensureGatewayOrder(UUID paymentId, String requestId) {
        record Outcome(PaymentView view, RuntimeException error, boolean publishFailed) {
        }
        Outcome outcome = tx.execute(s -> {
            PaymentTransaction p = transactions.lockById(paymentId).orElseThrow();
            if (p.getStatus() != PaymentStatus.CREATED) {
                return new Outcome(PaymentView.of(p, refundOf(p)), null, false);   // someone else finished it
            }
            try {
                RazorpayGateway.Order order = gateway.createOrder(p.getAmountInPaise(), p.getCurrency(), p.getOrderId(),
                        Map.of("orderId", p.getOrderId(), "userId", p.getUserId(), "paymentId", p.getId().toString()));
                if (order.amount() != p.getAmountInPaise() || !p.getCurrency().equals(order.currency())) {
                    // Must never happen; if it does, this payment is not safe to continue.
                    p.markFailed(null, "gateway_amount_mismatch: razorpay echoed " + order.amount() + " " + order.currency()
                            + " for " + p.getAmountInPaise() + " " + p.getCurrency());
                    log.error("razorpay order amount mismatch — payment FAILED", kv("orderId", p.getOrderId()),
                            kv("expectedAmountInPaise", p.getAmountInPaise()), kv("gatewayAmount", order.amount()));
                    return new Outcome(PaymentView.of(p, null), new Rejected(502, "AMOUNT_MISMATCH", "gateway echoed a different amount"), true);
                }
                p.attachGatewayOrder(order.id());
                log.info("razorpay order created — payment PENDING", kv("orderId", p.getOrderId()), kv("paymentId", p.getId()),
                        kv("razorpayOrderId", order.id()), kv("amountInPaise", order.amount()), kv("currency", order.currency()));
                return new Outcome(PaymentView.of(p, null), null, false);
            } catch (Unavailable e) {
                p.recordGatewayFailure(e.getMessage());
                log.error("razorpay unavailable — payment stays CREATED for retry / reconciliation",
                        kv("orderId", p.getOrderId()), kv("paymentId", p.getId()), kv("attempt", p.getGatewayAttempts()), kv("error", e.getMessage()));
                return new Outcome(PaymentView.of(p, null), e, false);
            } catch (Rejected e) {
                p.recordGatewayFailure(e.summary());
                p.markFailed(null, "gateway_rejected: " + e.summary());
                log.error("razorpay rejected the order — payment FAILED", kv("orderId", p.getOrderId()),
                        kv("paymentId", p.getId()), kv("error", e.summary()));
                return new Outcome(PaymentView.of(p, null), e, true);
            }
        });

        if (outcome.publishFailed()) {
            publisher.publish(PaymentEvent.failed(outcome.view(), requestId));
        }
        if (outcome.error() != null) {
            throw outcome.error();
        }
        return outcome.view();
    }

    // -------------------------------------------------------------------------
    // READ
    // -------------------------------------------------------------------------

    public PaymentView getByOrderId(String orderId) {
        return readOnlyTx.execute(s -> transactions.findByOrderId(orderId)
                .map(p -> PaymentView.of(p, refundOf(p)))
                .orElseThrow(() -> new PaymentNotFoundException(orderId)));
    }

    PaymentView view(UUID paymentId) {
        return readOnlyTx.execute(s -> transactions.findById(paymentId).map(p -> PaymentView.of(p, refundOf(p))).orElseThrow());
    }

    private PaymentRefund refundOf(PaymentTransaction p) {
        return refunds.findByPaymentId(p.getId()).orElse(null);
    }

    // -------------------------------------------------------------------------
    // REFUND (Kafka OrderCancelled, POST /payments/{orderId}/refund, reconciliation)
    // -------------------------------------------------------------------------

    public enum RefundOutcome { REFUNDED, REFUND_PENDING, ALREADY_REFUNDED, NOTHING_TO_REFUND }

    public record RefundResult(PaymentView payment, RefundOutcome outcome) {
    }

    /**
     * The compensating action for money. Idempotent at three levels:
     * <ol>
     *   <li>Status check under the row lock — SUCCESS is the only state that
     *       starts a refund; REFUND_PENDING resumes, REFUNDED is a no-op.</li>
     *   <li>{@code payment_refund.payment_id UNIQUE}: the refund row is inserted
     *       and COMMITTED before Razorpay is called, so a second cancellation —
     *       same eventId or a new one, now or next week — cannot create a second
     *       refund row and therefore cannot trigger a second refund.</li>
     *   <li>Before calling Razorpay, refunds already on the payment are listed
     *       and reused (covers "we refunded but the response was lost").</li>
     * </ol>
     *
     * @param strict true for the REST path: a payment with nothing to refund is
     *               an error (409). false for Kafka: it is a logged no-op.
     */
    public RefundResult refund(String orderId, String reason, String triggeredByEventId, boolean strict) {
        String requestId = Correlation.current();

        // Step 1 — claim the refund (own transaction; commits the refund row).
        record Claim(UUID paymentId, UUID refundId, RefundOutcome outcome, PaymentView view) {
        }
        Claim claim = tx.execute(s -> {
            PaymentTransaction p = transactions.lockByOrderId(orderId).orElseThrow(() -> new PaymentNotFoundException(orderId));
            PaymentRefund existing = refunds.lockByPaymentId(p.getId()).orElse(null);
            switch (p.getStatus()) {
                case SUCCESS -> {
                    if (existing != null && existing.getStatus() != PaymentRefund.Status.FAILED) {
                        return new Claim(p.getId(), existing.getId(), RefundOutcome.REFUND_PENDING, null);
                    }
                    if (existing != null) {
                        // A previous refund was refused by Razorpay; UNIQUE(payment_id) forbids a second row.
                        if (strict) {
                            throw new NothingToRefundException(orderId, "SUCCESS with a FAILED refund (" + existing.getLastGatewayError() + ")");
                        }
                        return new Claim(p.getId(), null, RefundOutcome.NOTHING_TO_REFUND, PaymentView.of(p, existing));
                    }
                    PaymentRefund r = new PaymentRefund(p, reason, triggeredByEventId, requestId);
                    refunds.saveAndFlush(r);
                    p.markRefundPending();
                    log.info("refund INITIATED — row committed before calling razorpay", kv("orderId", orderId),
                            kv("paymentId", p.getId()), kv("refundId", r.getId()), kv("amountInPaise", r.getAmountInPaise()), kv("reason", reason));
                    return new Claim(p.getId(), r.getId(), RefundOutcome.REFUND_PENDING, null);
                }
                case REFUND_PENDING -> {
                    return new Claim(p.getId(), existing != null ? existing.getId() : null, RefundOutcome.REFUND_PENDING, null);
                }
                case REFUNDED -> {
                    log.info("refund replayed — already REFUNDED, nothing changed", kv("orderId", orderId), kv("paymentId", p.getId()));
                    return new Claim(p.getId(), null, RefundOutcome.ALREADY_REFUNDED, PaymentView.of(p, existing));
                }
                default -> {
                    if (strict) {
                        throw new NothingToRefundException(orderId, p.getStatus().name());
                    }
                    log.info("cancellation for an unpaid order — nothing to refund", kv("orderId", orderId), kv("status", p.getStatus()));
                    return new Claim(p.getId(), null, RefundOutcome.NOTHING_TO_REFUND, PaymentView.of(p, existing));
                }
            }
        });
        if (claim.outcome() != RefundOutcome.REFUND_PENDING || claim.refundId() == null) {
            return new RefundResult(claim.view() != null ? claim.view() : view(claim.paymentId()), claim.outcome());
        }

        // Step 2 — talk to Razorpay (own transaction, row locks held for one round trip).
        return settleRefundWithGateway(claim.paymentId(), requestId);
    }

    /**
     * Executes / confirms the refund with Razorpay for a REFUND_PENDING payment.
     * Safe to call repeatedly: it only calls Razorpay when our refund row has no
     * razorpay_refund_id yet, and even then first looks for a refund Razorpay
     * already holds for that payment.
     */
    RefundResult settleRefundWithGateway(UUID paymentId, String requestId) {
        record Outcome(PaymentView view, RefundOutcome outcome, RuntimeException error) {
        }
        Outcome outcome = tx.execute(s -> {
            PaymentTransaction p = transactions.lockById(paymentId).orElseThrow();
            PaymentRefund r = refunds.lockByPaymentId(paymentId).orElse(null);
            if (r == null || p.getStatus() != PaymentStatus.REFUND_PENDING) {
                // Someone else (a concurrent cancellation, a webhook, reconciliation) finished it first.
                // ALREADY_REFUNDED, not REFUNDED: this call made no transition, so it must not publish.
                return new Outcome(PaymentView.of(p, r), p.getStatus() == PaymentStatus.REFUNDED ? RefundOutcome.ALREADY_REFUNDED : RefundOutcome.NOTHING_TO_REFUND, null);
            }
            try {
                RazorpayGateway.Refund gw = null;
                if (r.getRazorpayRefundId() == null) {
                    // Lost-response guard: reuse a refund Razorpay already has for this payment.
                    List<RazorpayGateway.Refund> already = gateway.listPaymentRefunds(p.getRazorpayPaymentId());
                    gw = already.stream().filter(x -> !x.isFailed()).findFirst().orElse(null);
                    if (gw != null) {
                        log.warn("razorpay already holds a refund for this payment — adopting it instead of creating another",
                                kv("orderId", p.getOrderId()), kv("razorpayRefundId", gw.id()));
                    } else {
                        gw = gateway.refundPayment(p.getRazorpayPaymentId(), r.getAmountInPaise(), r.getId().toString(),
                                Map.of("orderId", p.getOrderId(), "paymentId", p.getId().toString(), "refundId", r.getId().toString(), "reason", r.getReason()));
                    }
                } else {
                    gw = gateway.fetchRefund(r.getRazorpayRefundId());
                }
                if (gw.amount() != r.getAmountInPaise()) {
                    log.error("refund amount mismatch", kv("orderId", p.getOrderId()), kv("expected", r.getAmountInPaise()), kv("gateway", gw.amount()));
                }
                r.attachGatewayRefund(gw.id(), gw.isProcessed());
                if (gw.isProcessed()) {
                    p.markRefunded();
                    log.info("refund PROCESSED — payment REFUNDED", kv("orderId", p.getOrderId()), kv("paymentId", p.getId()),
                            kv("razorpayRefundId", gw.id()), kv("amountInPaise", gw.amount()));
                    return new Outcome(PaymentView.of(p, r), RefundOutcome.REFUNDED, null);
                }
                log.info("refund accepted by razorpay — awaiting refund.processed", kv("orderId", p.getOrderId()),
                        kv("razorpayRefundId", gw.id()), kv("gatewayStatus", gw.status()));
                return new Outcome(PaymentView.of(p, r), RefundOutcome.REFUND_PENDING, null);
            } catch (Unavailable e) {
                r.recordGatewayFailure(e.getMessage());
                log.error("razorpay unavailable — refund stays INITIATED for retry / reconciliation",
                        kv("orderId", p.getOrderId()), kv("refundId", r.getId()), kv("attempt", r.getGatewayAttempts()), kv("error", e.getMessage()));
                return new Outcome(PaymentView.of(p, r), RefundOutcome.REFUND_PENDING, e);
            } catch (Rejected e) {
                r.markFailed(e.summary());
                p.markRefundFailed(e.summary());
                log.error("razorpay REFUSED the refund — payment back to SUCCESS, needs a human",
                        kv("orderId", p.getOrderId()), kv("refundId", r.getId()), kv("error", e.summary()));
                return new Outcome(PaymentView.of(p, r), RefundOutcome.NOTHING_TO_REFUND, e);
            }
        });

        if (outcome.outcome() == RefundOutcome.REFUNDED) {
            publisher.publish(PaymentEvent.refunded(outcome.view(), requestId));
        }
        if (outcome.error() != null) {
            throw outcome.error();
        }
        return new RefundResult(outcome.view(), outcome.outcome());
    }

    public PaymentProperties properties() {
        return properties;
    }

    Clock clock() {
        return clock;
    }
}
