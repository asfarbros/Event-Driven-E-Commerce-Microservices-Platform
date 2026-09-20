package com.orderflow.order.outbox;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import com.orderflow.order.domain.OutboxEvent;
import com.orderflow.order.domain.OrderRepository;
import com.orderflow.order.domain.OutboxRepository;
import com.orderflow.order.domain.ProcessedEventRepository;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import jakarta.annotation.PreDestroy;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * THE TRANSACTIONAL OUTBOX RELAY — the dual-write solution.
 *
 * <p>Problem: "commit the order as CONFIRMED" and "publish OrderConfirmed"
 * are two systems; there is no transaction spanning both. Publish first and
 * the commit may fail (event without state); commit first and the process may
 * die before publishing (state without event — Inventory would keep the hold
 * forever). Solution: the state change writes the message into
 * {@code outbox_event} in the SAME database transaction ({@link OutboxWriter});
 * this relay publishes unpublished rows afterwards and marks them published.
 *
 * <p><b>Guarantee: at-least-once, in order per order.</b>
 * <ul>
 *   <li>Never lost: a row exists iff its state change committed; the relay
 *       keeps retrying it (attempts + last_error recorded) until the broker
 *       confirms it — Kafka {@code acks=all} awaited synchronously, RabbitMQ
 *       publisher confirms awaited synchronously.</li>
 *   <li>Failure mode — duplicates: if the process dies AFTER the broker acked
 *       and BEFORE {@code published_at} is written, the row is published again
 *       on restart. Every message therefore carries a stable id
 *       ({@code eventId} / {@code messageId}) and every consumer deduplicates:
 *       Inventory by reservation status, Payment by
 *       {@code refund_payment_unique}, this service by {@code processed_event},
 *       the notification worker by {@code messageId}.</li>
 *   <li>Failure mode — delay: while Kafka / RabbitMQ is down, rows accumulate
 *       (visible on /health as {@code outbox.pending}) and drain when the
 *       broker returns. Nothing blocks the HTTP path.</li>
 *   <li>Ordering: rows are relayed oldest-first, one at a time; Kafka records
 *       are keyed by orderId, so one order's events stay in order on one
 *       partition.</li>
 * </ul>
 *
 * <p>Two triggers: a scheduled sweep every {@code ORDER_OUTBOX_RELAY_INTERVAL_MS}
 * (the safety net), and an after-commit "nudge" from every writer so the
 * normal-path latency is milliseconds, not the interval. Rows are locked with
 * {@code FOR UPDATE SKIP LOCKED}, so several instances / overlapping runs
 * never publish the same row concurrently.
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);
    private static final long KAFKA_ACK_TIMEOUT_MS = 10_000;

    private final OutboxRepository outbox;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final RabbitTemplate rabbitTemplate;
    private final OrderProperties properties;
    private final TransactionTemplate tx;
    private final Clock clock;

    private final AtomicBoolean running = new AtomicBoolean();
    private final AtomicLong publishedTotal = new AtomicLong();
    private final AtomicReference<String> lastError = new AtomicReference<>();

    public OutboxRelay(OutboxRepository outbox, KafkaTemplate<String, String> kafkaTemplate, RabbitTemplate rabbitTemplate,
                       OrderProperties properties, PlatformTransactionManager transactionManager, Clock clock) {
        this.outbox = outbox;
        this.kafkaTemplate = kafkaTemplate;
        this.rabbitTemplate = rabbitTemplate;
        this.properties = properties;
        // REQUIRES_NEW: the relay must never join a caller's transaction. In
        // particular an afterCommit() callback still has the committed
        // transaction's resources bound to its thread; joining it would make
        // the published_at update silently vanish (and the row be re-sent).
        this.tx = new TransactionTemplate(transactionManager);
        this.tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.clock = clock;
        this.relayExecutor = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "outbox-relay");
            t.setDaemon(true);
            return t;
        });
    }

    private final ExecutorService relayExecutor;

    /**
     * Call from inside a transaction: schedules a relay run for right after
     * that transaction commits, on the relay's own thread (so the HTTP or
     * Kafka thread returns immediately and the run has a clean transactional
     * context).
     */
    public void nudgeAfterCommit() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    relayExecutor.submit(OutboxRelay.this::relay);
                }
            });
        }
    }

    @PreDestroy
    void shutdown() {
        relayExecutor.shutdown();
        try {
            relayExecutor.awaitTermination(10, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Scheduled(fixedDelayString = "${order.outbox.relay-interval-ms}", initialDelayString = "${order.outbox.relay-interval-ms}")
    public void scheduledRelay() {
        relay();
    }

    /** Publishes every unpublished row it can lock. Returns the number published. */
    public int relay() {
        if (!properties.outbox().enabled()) {
            return 0;   // relay switched off (tests / a read-only instance): rows wait for an enabled instance
        }
        if (!running.compareAndSet(false, true)) {
            return 0;   // a run is already in progress in this instance; it will pick up new rows
        }
        int published = 0;
        try {
            List<UUID> ids = outbox.findUnpublishedIds(properties.outbox().batchSize());
            for (UUID id : ids) {
                if (relayOne(id)) {
                    published++;
                }
            }
            if (published > 0) {
                publishedTotal.addAndGet(published);
            }
        } catch (RuntimeException e) {
            lastError.set(e.getMessage());
            log.error("outbox relay run failed", e);
        } finally {
            running.set(false);
        }
        return published;
    }

    private boolean relayOne(UUID id) {
        Boolean result = tx.execute(status -> {
            Optional<OutboxEvent> locked = outbox.lockUnpublished(id);
            if (locked.isEmpty()) {
                return false;   // published meanwhile, or another instance holds it
            }
            OutboxEvent row = locked.get();
            String correlationId = row.getCorrelationId() != null ? row.getCorrelationId() : Correlation.current();
            try {
                switch (row.getDestination()) {
                    case KAFKA -> publishKafka(row, correlationId);
                    case RABBITMQ -> publishRabbit(row, correlationId);
                }
                row.markPublished(clock.instant());
                lastError.set(null);
                return true;
            } catch (Exception e) {
                row.recordFailure(rootMessage(e));
                lastError.set(rootMessage(e));
                log.error("outbox: publish failed — will retry", kv(Correlation.MDC_KEY, correlationId), kv("orderId", row.getOrderId()),
                        kv("destination", row.getDestination()), kv("eventType", row.getEventType()), kv("messageId", row.getMessageId()),
                        kv("attempt", row.getAttempts()), kv("error", rootMessage(e)));
                return false;
            }
        });
        return Boolean.TRUE.equals(result);
    }

    private void publishKafka(OutboxEvent row, String correlationId) throws Exception {
        ProducerRecord<String, String> record = new ProducerRecord<>(row.getTarget(), row.getRoutingKey(), row.getPayload());
        record.headers()
                .add(Correlation.HEADER, bytes(correlationId))
                .add("X-Event-Type", bytes(row.getEventType()))
                .add("X-Event-Id", bytes(row.getMessageId()))
                .add("X-Event-Version", bytes(Integer.toString(OutboxWriter.SCHEMA_VERSION)))
                .add("X-Source", bytes(OutboxWriter.SOURCE))
                .add("Content-Type", bytes("application/json"));
        var meta = kafkaTemplate.send(record).get(KAFKA_ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS).getRecordMetadata();
        log.info("outbox: event published", kv(Correlation.MDC_KEY, correlationId), kv("orderId", row.getOrderId()),
                kv("topic", row.getTarget()), kv("partition", meta.partition()), kv("offset", meta.offset()),
                kv("eventType", row.getEventType()), kv("eventId", row.getMessageId()));
    }

    private void publishRabbit(OutboxEvent row, String correlationId) {
        MessageProperties props = new MessageProperties();
        props.setMessageId(row.getMessageId());
        props.setCorrelationId(correlationId);
        props.setType(row.getEventType());
        props.setContentType(MessageProperties.CONTENT_TYPE_JSON);
        props.setContentEncoding("UTF-8");
        props.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
        props.setTimestamp(java.util.Date.from(clock.instant()));
        props.setHeader(Correlation.HEADER, correlationId);
        props.setHeader("X-Source", OutboxWriter.SOURCE);
        Message message = new Message(row.getPayload().getBytes(StandardCharsets.UTF_8), props);

        // Publisher confirm: wait for the broker to ack THIS message; a nack, a
        // timeout, or an unroutable return (mandatory=true) all throw → retried.
        CorrelationData cd = new CorrelationData(row.getMessageId());
        rabbitTemplate.send(row.getTarget(), row.getRoutingKey(), message, cd);
        CorrelationData.Confirm confirm;
        try {
            confirm = cd.getFuture().get(properties.rabbit().confirmTimeoutMs(), TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            throw new IllegalStateException("rabbitmq publisher confirm not received: " + rootMessage(e), e);
        }
        if (!confirm.isAck()) {
            throw new IllegalStateException("rabbitmq NACKed the publish: " + confirm.getReason());
        }
        if (cd.getReturned() != null) {
            throw new IllegalStateException("rabbitmq returned the message as unroutable: " + cd.getReturned().getReplyText());
        }
        log.info("outbox: notification command published", kv(Correlation.MDC_KEY, correlationId), kv("orderId", row.getOrderId()),
                kv("exchange", row.getTarget()), kv("routingKey", row.getRoutingKey()), kv("commandType", row.getEventType()),
                kv("messageId", row.getMessageId()));
    }

    public long pending() {
        return outbox.countByPublishedAtIsNull();
    }

    public long publishedTotal() {
        return publishedTotal.get();
    }

    public String lastError() {
        return lastError.get();
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    static String rootMessage(Throwable t) {
        Throwable r = t;
        while (r.getCause() != null && r.getCause() != r) {
            r = r.getCause();
        }
        return r.getClass().getSimpleName() + (r.getMessage() != null ? ": " + r.getMessage() : "");
    }
}
