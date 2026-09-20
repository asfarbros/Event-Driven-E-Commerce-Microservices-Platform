package com.orderflow.payment.kafka;

import java.nio.charset.StandardCharsets;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.payment.correlation.Correlation;
import com.orderflow.payment.service.PaymentService;
import com.orderflow.payment.service.ServiceExceptions.PaymentNotFoundException;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.common.header.Header;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Consumes {@code order-events} (same envelope Inventory consumes):
 * <pre>
 * { "eventType": "OrderCancelled", "version": 1, "eventId": "…", "orderId": "…", "occurredAt": "…" }
 * </pre>
 * with the {@code X-Request-Id} header as correlation id.
 *
 * <p>{@code OrderCancelled} for an order that was already PAID → refund with
 * Razorpay (the compensating action for money). For an unpaid order it is a
 * logged no-op; an order with no payment record at all is also a no-op (the
 * order never reached checkout). Other event types are ignored.
 *
 * <p>Idempotent: {@link PaymentService#refund} checks the status under a row
 * lock and the refund row's UNIQUE(payment_id) forbids a second refund — the
 * same cancellation delivered twice cannot refund twice.
 *
 * <p>Offsets are acknowledged manually after the service call returns; a
 * throw means no ack → retry with backoff → dead-letter topic
 * ({@link KafkaConsumerConfig}).
 */
@Component
public class OrderEventsListener {

    private static final Logger log = LoggerFactory.getLogger(OrderEventsListener.class);
    public static final String ORDER_CANCELLED = "OrderCancelled";

    private final PaymentService paymentService;
    private final ObjectMapper objectMapper;

    public OrderEventsListener(PaymentService paymentService, ObjectMapper objectMapper) {
        this.paymentService = paymentService;
        this.objectMapper = objectMapper;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record OrderEvent(String eventType, Integer version, String eventId, String orderId, String occurredAt) {
    }

    @KafkaListener(
            topics = "${payment.kafka.order-events-topic}",
            groupId = "${payment.kafka.consumer-group}",
            autoStartup = "${payment.kafka.consumer-enabled}")
    public void onOrderEvent(ConsumerRecord<String, String> record, Acknowledgment ack) {
        Correlation.set(correlationIdOf(record));
        try {
            OrderEvent event = parse(record);
            if (ORDER_CANCELLED.equals(event.eventType())) {
                log.info("consuming OrderCancelled", kv("orderId", event.orderId()), kv("eventId", event.eventId()),
                        kv("partition", record.partition()), kv("offset", record.offset()));
                try {
                    PaymentService.RefundResult result = paymentService.refund(event.orderId(), "order_cancelled", event.eventId(), false);
                    log.info("OrderCancelled handled", kv("orderId", event.orderId()), kv("outcome", result.outcome()),
                            kv("status", result.payment().status()));
                } catch (PaymentNotFoundException e) {
                    log.info("OrderCancelled for an order with no payment record — nothing to refund", kv("orderId", event.orderId()));
                }
            } else {
                log.debug("ignoring order event of another type", kv("eventType", event.eventType()), kv("offset", record.offset()));
            }
            ack.acknowledge();
        } finally {
            Correlation.clear();
        }
    }

    private OrderEvent parse(ConsumerRecord<String, String> record) {
        if (record.value() == null || record.value().isBlank()) {
            throw new MalformedEventException("empty record value");
        }
        OrderEvent event;
        try {
            event = objectMapper.readValue(record.value(), OrderEvent.class);
        } catch (Exception e) {
            throw new MalformedEventException("record value is not valid JSON for an order event: " + e.getMessage());
        }
        if (event.eventType() == null || event.eventType().isBlank()) {
            throw new MalformedEventException("eventType is missing");
        }
        if (ORDER_CANCELLED.equals(event.eventType()) && (event.orderId() == null || !event.orderId().matches("^[A-Za-z0-9._-]{1,64}$"))) {
            throw new MalformedEventException("orderId is missing or malformed for " + event.eventType());
        }
        return event;
    }

    static String correlationIdOf(ConsumerRecord<?, ?> record) {
        Header header = record.headers().lastHeader(Correlation.HEADER);
        if (header != null && header.value() != null) {
            String value = new String(header.value(), StandardCharsets.UTF_8);
            if (Correlation.isValid(value)) {
                return value;
            }
        }
        return Correlation.newId("evt");
    }
}
