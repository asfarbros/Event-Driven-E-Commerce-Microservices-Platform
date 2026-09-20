package com.orderflow.payment.service;

import java.util.Optional;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.payment.config.PaymentProperties;
import com.orderflow.payment.correlation.Correlation;
import com.orderflow.payment.domain.PaymentRefund;
import com.orderflow.payment.domain.PaymentRefundRepository;
import com.orderflow.payment.domain.PaymentStatus;
import com.orderflow.payment.domain.PaymentTransaction;
import com.orderflow.payment.domain.PaymentTransactionRepository;
import com.orderflow.payment.domain.WebhookEvent;
import com.orderflow.payment.domain.WebhookEventRepository;
import com.orderflow.payment.razorpay.PayloadRedactor;
import com.orderflow.payment.razorpay.WebhookSignature;
import com.orderflow.payment.service.ServiceExceptions.InvalidWebhookException;
import com.orderflow.payment.service.ServiceExceptions.InvalidWebhookSignatureException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Razorpay webhooks — the RELIABLE source of payment truth. (The browser
 * callback is never trusted: the tab may be closed before it fires, and the
 * browser could lie.)
 *
 * <p>Processing order, strictly:
 * <ol>
 *   <li><b>Verify the signature</b> over the RAW body with the webhook secret.
 *       Unverified → 400, nothing stored, nothing logged from the body.</li>
 *   <li><b>Deduplicate</b>: insert into webhook_event keyed by Razorpay's
 *       {@code X-Razorpay-Event-Id}. The insert is flushed inside the SAME
 *       transaction that applies the effect, so a redelivery hits
 *       UNIQUE(provider, provider_event_id), the whole transaction rolls back,
 *       and we answer 200 "duplicate" without touching the payment or Kafka.</li>
 *   <li><b>Apply</b> under a row lock on the payment: captured → SUCCESS,
 *       failed → FAILED (+ reason), refund.processed → REFUNDED. The amount in
 *       the webhook must equal ours.</li>
 *   <li><b>Publish</b> the Kafka event — after commit only.</li>
 * </ol>
 * A transient failure (database down) rolls everything back and surfaces as a
 * 500, so Razorpay retries and the retry is processed as a first delivery.
 */
@Service
public class WebhookService {

    private static final Logger log = LoggerFactory.getLogger(WebhookService.class);
    public static final String PROVIDER = "razorpay";

    public enum Outcome { PROCESSED, DUPLICATE, IGNORED, REJECTED }

    public record Result(Outcome outcome, String eventType, String note) {
    }

    private final PaymentTransactionRepository transactions;
    private final PaymentRefundRepository refunds;
    private final WebhookEventRepository webhooks;
    private final PaymentEventPublisher publisher;
    private final ObjectMapper objectMapper;
    private final String webhookSecret;
    private final TransactionTemplate tx;
    private final java.time.Clock clock;

    public WebhookService(PaymentTransactionRepository transactions, PaymentRefundRepository refunds,
                          WebhookEventRepository webhooks, PaymentEventPublisher publisher, ObjectMapper objectMapper,
                          PaymentProperties properties, PlatformTransactionManager transactionManager, java.time.Clock clock) {
        this.transactions = transactions;
        this.refunds = refunds;
        this.webhooks = webhooks;
        this.publisher = publisher;
        this.objectMapper = objectMapper;
        this.webhookSecret = properties.razorpay().webhookSecret();
        this.tx = new TransactionTemplate(transactionManager);
        this.clock = clock;
    }

    public Result process(String rawBody, String signatureHeader, String eventIdHeader) {
        // 1. Signature over the raw bytes, before anything else looks at the body.
        if (!WebhookSignature.verify(rawBody, signatureHeader, webhookSecret)) {
            log.warn("webhook REJECTED — signature verification failed", kv("eventId", eventIdHeader),
                    kv("bodyBytes", rawBody == null ? 0 : rawBody.length()));
            throw new InvalidWebhookSignatureException();
        }
        if (eventIdHeader == null || eventIdHeader.isBlank() || eventIdHeader.length() > 128) {
            throw new InvalidWebhookException("X-Razorpay-Event-Id header is missing or malformed");
        }
        JsonNode body;
        try {
            body = objectMapper.readTree(rawBody);
        } catch (Exception e) {
            throw new InvalidWebhookException("body is not valid JSON");
        }
        String eventType = body.path("event").asText(null);
        if (eventType == null || eventType.isBlank()) {
            throw new InvalidWebhookException("body has no \"event\" field");
        }
        JsonNode payment = body.path("payload").path("payment").path("entity");
        JsonNode refund = body.path("payload").path("refund").path("entity");
        JsonNode order = body.path("payload").path("order").path("entity");
        String razorpayOrderId = firstText(payment.path("order_id"), order.path("id"));
        String razorpayPaymentId = firstText(payment.path("id"), refund.path("payment_id"));
        String razorpayRefundId = refund.path("id").asText(null);
        String orderId = firstText(payment.path("notes").path("orderId"), order.path("receipt"), order.path("notes").path("orderId"));
        String requestId = Correlation.current();
        String redacted = PayloadRedactor.redact(body).toString();

        log.info("webhook received", kv("eventType", eventType), kv("eventId", eventIdHeader),
                kv("razorpayOrderId", razorpayOrderId), kv("razorpayPaymentId", razorpayPaymentId), kv("orderId", orderId));

        // 2 + 3. Inbox insert and state change in ONE transaction.
        Applied applied;
        try {
            applied = tx.execute(s -> {
                WebhookEvent inbox = new WebhookEvent(PROVIDER, eventIdHeader, eventType, razorpayOrderId, razorpayPaymentId,
                        razorpayRefundId, orderId, redacted, requestId, clock.instant());
                webhooks.saveAndFlush(inbox);      // UNIQUE(provider, provider_event_id) fires HERE on a redelivery

                Applied a = apply(eventType, payment, refund, razorpayOrderId, razorpayPaymentId, razorpayRefundId, requestId);
                inbox.resolve(a.status(), a.note(), clock.instant());
                return a;
            });
        } catch (DataIntegrityViolationException e) {
            if (!isInboxDuplicate(e)) {
                throw e;   // some other constraint fired — a real error, let the handler/500 path report it
            }
            log.info("webhook DUPLICATE — already processed, acknowledged without changes",
                    kv("eventType", eventType), kv("eventId", eventIdHeader));
            return new Result(Outcome.DUPLICATE, eventType, "already processed");
        }

        // 4. Publish after commit.
        if (applied.event() != null) {
            publisher.publish(applied.event());
        }
        Outcome outcome = applied.status() == WebhookEvent.Status.PROCESSED ? Outcome.PROCESSED : Outcome.IGNORED;
        log.info("webhook " + outcome, kv("eventType", eventType), kv("eventId", eventIdHeader), kv("note", applied.note()));
        return new Result(outcome, eventType, applied.note());
    }

    private Applied apply(String eventType, JsonNode payment, JsonNode refund, String razorpayOrderId,
                           String razorpayPaymentId, String razorpayRefundId, String requestId) {
        switch (eventType) {
            case "payment.captured", "order.paid" -> {
                return applyCaptured(payment, razorpayOrderId, razorpayPaymentId, requestId);
            }
            case "payment.failed" -> {
                return applyFailed(payment, razorpayOrderId, razorpayPaymentId, requestId);
            }
            case "refund.processed" -> {
                return applyRefund(razorpayPaymentId, razorpayRefundId, refund, true, requestId);
            }
            case "refund.failed" -> {
                return applyRefund(razorpayPaymentId, razorpayRefundId, refund, false, requestId);
            }
            default -> {
                return Applied.ignored("event type not handled");
            }
        }
    }

    private Applied applyCaptured(JsonNode payment, String razorpayOrderId, String razorpayPaymentId, String requestId) {
        if (razorpayOrderId == null) {
            return Applied.ignored("no razorpay order id in payload");
        }
        Optional<PaymentTransaction> found = transactions.lockByRazorpayOrderId(razorpayOrderId);
        if (found.isEmpty()) {
            return Applied.ignored("no payment_transaction for razorpay order " + razorpayOrderId);
        }
        PaymentTransaction p = found.get();
        long amount = payment.path("amount").asLong(-1);
        String currency = payment.path("currency").asText(null);
        if (amount != -1 && (amount != p.getAmountInPaise() || (currency != null && !currency.equals(p.getCurrency())))) {
            log.error("webhook amount does not match our record — NOT marking SUCCESS", kv("orderId", p.getOrderId()),
                    kv("ourAmountInPaise", p.getAmountInPaise()), kv("webhookAmount", amount), kv("webhookCurrency", currency));
            return new Applied(WebhookEvent.Status.FAILED, "amount mismatch: ours " + p.getAmountInPaise() + " " + p.getCurrency()
                    + ", webhook " + amount + " " + currency, null);
        }
        if (p.isSettled()) {
            return Applied.ignored("payment already " + p.getStatus());
        }
        PaymentStatus before = p.getStatus();
        p.markSuccess(razorpayPaymentId);
        log.info("payment SUCCESS", kv("orderId", p.getOrderId()), kv("paymentId", p.getId()), kv("from", before),
                kv("razorpayPaymentId", razorpayPaymentId), kv("amountInPaise", p.getAmountInPaise()), kv("method", payment.path("method").asText(null)));
        return new Applied(WebhookEvent.Status.PROCESSED, before + " -> SUCCESS", PaymentEvent.succeeded(PaymentView.of(p, null), requestId));
    }

    private Applied applyFailed(JsonNode payment, String razorpayOrderId, String razorpayPaymentId, String requestId) {
        if (razorpayOrderId == null) {
            return Applied.ignored("no razorpay order id in payload");
        }
        Optional<PaymentTransaction> found = transactions.lockByRazorpayOrderId(razorpayOrderId);
        if (found.isEmpty()) {
            return Applied.ignored("no payment_transaction for razorpay order " + razorpayOrderId);
        }
        PaymentTransaction p = found.get();
        if (p.getStatus() != PaymentStatus.PENDING) {
            return Applied.ignored("payment is " + p.getStatus() + " — a failed attempt does not change it");
        }
        String reason = firstText(payment.path("error_description"), payment.path("error_reason"), payment.path("error_code"));
        p.markFailed(razorpayPaymentId, reason != null ? reason : "payment failed");
        log.warn("payment FAILED", kv("orderId", p.getOrderId()), kv("paymentId", p.getId()),
                kv("razorpayPaymentId", razorpayPaymentId), kv("failureReason", p.getFailureReason()));
        return new Applied(WebhookEvent.Status.PROCESSED, "PENDING -> FAILED", PaymentEvent.failed(PaymentView.of(p, null), requestId));
    }

    private Applied applyRefund(String razorpayPaymentId, String razorpayRefundId, JsonNode refundNode, boolean processed, String requestId) {
        if (razorpayPaymentId == null) {
            return Applied.ignored("no razorpay payment id in payload");
        }
        Optional<PaymentTransaction> found = transactions.lockByRazorpayPaymentId(razorpayPaymentId);
        if (found.isEmpty()) {
            return Applied.ignored("no payment_transaction for razorpay payment " + razorpayPaymentId);
        }
        PaymentTransaction p = found.get();
        PaymentRefund r = refunds.lockByPaymentId(p.getId()).orElse(null);
        if (!processed) {
            if (r != null && r.getStatus() == PaymentRefund.Status.INITIATED) {
                r.markFailed("refund.failed webhook");
                p.markRefundFailed("refund.failed webhook");
                log.error("refund FAILED (webhook) — payment back to SUCCESS, needs a human", kv("orderId", p.getOrderId()), kv("razorpayRefundId", razorpayRefundId));
                return new Applied(WebhookEvent.Status.PROCESSED, "refund failed", null);
            }
            return Applied.ignored("no INITIATED refund to fail");
        }
        if (p.getStatus() == PaymentStatus.REFUNDED) {
            return Applied.ignored("payment already REFUNDED");
        }
        if (r == null) {
            // Refund made outside this service (Razorpay dashboard). Record it so our books match Razorpay's.
            r = new PaymentRefund(p, "external_refund", null, requestId);
            refunds.save(r);
            log.warn("refund.processed for a refund this service did not start — recording it", kv("orderId", p.getOrderId()), kv("razorpayRefundId", razorpayRefundId));
        }
        r.attachGatewayRefund(razorpayRefundId, true);
        p.markRefunded();
        log.info("payment REFUNDED (webhook)", kv("orderId", p.getOrderId()), kv("paymentId", p.getId()),
                kv("razorpayRefundId", razorpayRefundId), kv("amountInPaise", refundNode.path("amount").asLong()));
        return new Applied(WebhookEvent.Status.PROCESSED, "-> REFUNDED", PaymentEvent.refunded(PaymentView.of(p, r), requestId));
    }

    /** Result of applying one webhook inside the transaction. */
    record Applied(WebhookEvent.Status status, String note, PaymentEvent event) {
        static Applied ignored(String note) {
            return new Applied(WebhookEvent.Status.IGNORED, note, null);
        }
    }

    /** True only when the violated constraint is the inbox's UNIQUE(provider, provider_event_id). */
    static boolean isInboxDuplicate(DataIntegrityViolationException e) {
        Throwable t = e;
        while (t != null) {
            if (t instanceof org.hibernate.exception.ConstraintViolationException cve) {
                return "webhook_provider_event_unique".equalsIgnoreCase(cve.getConstraintName());
            }
            if (t.getMessage() != null && t.getMessage().contains("webhook_provider_event_unique")) {
                return true;
            }
            t = t.getCause();
        }
        return false;
    }

    private static String firstText(JsonNode... nodes) {
        for (JsonNode n : nodes) {
            if (n != null && n.isTextual() && !n.asText().isBlank()) {
                return n.asText();
            }
        }
        return null;
    }
}
